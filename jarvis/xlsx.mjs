/**
 * A STREAMING .xlsx ROW READER, in about three hundred lines and no new
 * dependencies.
 *
 * The Department of Labor publishes its LCA disclosure data — the only
 * authoritative answer to "does this employer actually sponsor, and at what
 * wage level" — as .xlsx and nothing else. No CSV, no JSON, no API. The file
 * is hundreds of megabytes and unzips to gigabytes.
 *
 * The project has three runtime dependencies and a rule about adding more, so
 * this reads the format directly. It is less work than it sounds, because an
 * .xlsx is a ZIP of XML and Node ships both halves:
 *
 *   ZIP   → the central directory gives byte offsets; `zlib.createInflateRaw`
 *           decompresses a member without holding it whole.
 *   XML   → the sheet is a predictable `<row><c><v>` shape, so a scanner over
 *           the inflate stream beats a DOM that would need the gigabytes.
 *
 * MEMORY IS THE WHOLE DESIGN. Nothing here materialises a sheet:
 *
 *   · rows are handed to a callback one at a time and then dropped;
 *   · the shared-string table — the one thing that must be held, because cells
 *     reference it by index — is kept as ONE concatenated Buffer plus an
 *     offset array, not as a JS array of millions of strings. At roughly 3
 *     million unique strings the difference is about 150 MB of object headers
 *     against none.
 *
 * Deliberately NOT a general xlsx library. It reads the first worksheet of a
 * machine-generated flat table and understands the cell types such files
 * actually contain. It does not do styles, formulas, merged cells or charts,
 * and it should not grow to.
 */
import { openSync, readSync, closeSync, statSync, createReadStream } from 'node:fs';
import { createInflateRaw } from 'node:zlib';

// ── ZIP ─────────────────────────────────────────────────────────────

const EOCD_SIG = 0x06054b50;
const EOCD64_SIG = 0x06064b50;
const EOCD64_LOC_SIG = 0x07064b50;
const CEN_SIG = 0x02014b50;

/**
 * The end-of-central-directory record, which is at the end of the file behind
 * a comment of unknown length — so it is found by scanning backwards.
 */
function findEocd(fd, size) {
  const max = Math.min(size, 0x10000 + 22);
  const buf = Buffer.alloc(max);
  readSync(fd, buf, 0, max, size - max);
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) !== EOCD_SIG) continue;
    const base = size - max + i;
    const rec = {
      entries: buf.readUInt16LE(i + 10),
      cenSize: buf.readUInt32LE(i + 12),
      cenOffset: buf.readUInt32LE(i + 16),
    };
    // ZIP64. Excel writes it once a member passes 4 GB, which the DOL's sheet
    // does, and reading the 32-bit fields then yields 0xFFFFFFFF — a central
    // directory "at" 4 GB, and a reader that finds nothing at all.
    if (rec.cenOffset === 0xFFFFFFFF || rec.entries === 0xFFFF || rec.cenSize === 0xFFFFFFFF) {
      const locAt = i - 20;
      if (locAt >= 0 && buf.readUInt32LE(locAt) === EOCD64_LOC_SIG) {
        const eocd64At = Number(buf.readBigUInt64LE(locAt + 8));
        const z = Buffer.alloc(56);
        readSync(fd, z, 0, 56, eocd64At);
        if (z.readUInt32LE(0) === EOCD64_SIG) {
          rec.entries = Number(z.readBigUInt64LE(32));
          rec.cenSize = Number(z.readBigUInt64LE(40));
          rec.cenOffset = Number(z.readBigUInt64LE(48));
        }
      }
    }
    rec.at = base;
    return rec;
  }
  return null;
}

/** Every member of the archive, by name, with where its data starts. */
export function zipEntries(file) {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size;
    const eocd = findEocd(fd, size);
    if (!eocd) throw new Error('not a zip: no end-of-central-directory record');
    const cen = Buffer.alloc(eocd.cenSize);
    readSync(fd, cen, 0, eocd.cenSize, eocd.cenOffset);

    const out = new Map();
    let p = 0;
    while (p + 46 <= cen.length && cen.readUInt32LE(p) === CEN_SIG) {
      const method = cen.readUInt16LE(p + 10);
      let compressed = cen.readUInt32LE(p + 20);
      let uncompressed = cen.readUInt32LE(p + 24);
      const nameLen = cen.readUInt16LE(p + 28);
      const extraLen = cen.readUInt16LE(p + 30);
      const commentLen = cen.readUInt16LE(p + 32);
      let localOffset = cen.readUInt32LE(p + 42);
      const name = cen.toString('utf8', p + 46, p + 46 + nameLen);

      // The ZIP64 extra field carries the real values for whichever 32-bit
      // fields are saturated, IN THAT ORDER and only those.
      if (uncompressed === 0xFFFFFFFF || compressed === 0xFFFFFFFF || localOffset === 0xFFFFFFFF) {
        let e = p + 46 + nameLen;
        const end = e + extraLen;
        while (e + 4 <= end) {
          const id = cen.readUInt16LE(e);
          const len = cen.readUInt16LE(e + 2);
          if (id === 0x0001) {
            let q = e + 4;
            if (uncompressed === 0xFFFFFFFF) { uncompressed = Number(cen.readBigUInt64LE(q)); q += 8; }
            if (compressed === 0xFFFFFFFF) { compressed = Number(cen.readBigUInt64LE(q)); q += 8; }
            if (localOffset === 0xFFFFFFFF) { localOffset = Number(cen.readBigUInt64LE(q)); q += 8; }
            break;
          }
          e += 4 + len;
        }
      }
      out.set(name, { name, method, compressed, uncompressed, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries: out, size };
  } finally { closeSync(fd); }
}

/** Where a member's bytes actually begin — past its local header. */
function dataStart(file, entry) {
  const fd = openSync(file, 'r');
  try {
    const h = Buffer.alloc(30);
    readSync(fd, h, 0, 30, entry.localOffset);
    if (h.readUInt32LE(0) !== 0x04034b50) throw new Error(`bad local header for ${entry.name}`);
    return entry.localOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  } finally { closeSync(fd); }
}

/** A readable stream of one member's decompressed bytes. */
export function openMember(file, entry) {
  const start = dataStart(file, entry);
  const raw = createReadStream(file, { start, end: start + entry.compressed - 1, highWaterMark: 1 << 20 });
  if (entry.method === 0) return raw;
  if (entry.method !== 8) throw new Error(`unsupported zip compression ${entry.method} for ${entry.name}`);
  return raw.pipe(createInflateRaw());
}

// ── XML, at the shape a spreadsheet actually writes ─────────────────

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function unescapeXml(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(parseInt(e[1] === 'x' || e[1] === 'X' ? e.slice(2) : e.slice(1), e[1] === 'x' || e[1] === 'X' ? 16 : 10));
    return ENT[e] ?? m;
  });
}

/**
 * The shared-string table, held as bytes rather than as objects.
 *
 * `<si>` can contain one `<t>` or several (rich text runs, where one cell's
 * value is split across formatting changes). Every `<t>` inside one `<si>`
 * concatenates into a single value; treating them as separate strings shifts
 * every later index by one and silently rewrites the whole sheet.
 */
export async function readSharedStrings(file, entries) {
  const entry = entries.get('xl/sharedStrings.xml');
  if (!entry) return { count: 0, get: () => '' };

  const chunks = [];
  const offsets = [0];
  let total = 0;
  let buf = '';
  let inSi = false;
  let current = [];

  const push = (s) => {
    const b = Buffer.from(s, 'utf8');
    chunks.push(b);
    total += b.length;
    offsets.push(total);
  };

  for await (const chunk of openMember(file, entry)) {
    buf += chunk.toString('utf8');
    // Keep the tail back until a tag is certainly complete.
    let safe = buf.lastIndexOf('>');
    if (safe === -1) continue;
    const work = buf.slice(0, safe + 1);
    buf = buf.slice(safe + 1);

    const re = /<(\/?)(si|t)\b([^>]*)>|<t\b[^>]*\/>/g;
    let m;
    let last = 0;
    while ((m = re.exec(work)) !== null) {
      const [full, slash, tag, attrs] = m;
      if (full.endsWith('/>') && !slash) { last = re.lastIndex; continue; }
      if (tag === 'si') {
        if (slash) { push(current.join('')); current = []; inSi = false; }
        else { inSi = true; current = []; }
        last = re.lastIndex;
        continue;
      }
      if (tag === 't' && !slash) {
        if (attrs && attrs.trim().endsWith('/')) { last = re.lastIndex; continue; }
        const close = work.indexOf('</t>', re.lastIndex);
        if (close === -1) {
          // The text runs past this chunk: give it back and wait for more.
          buf = work.slice(m.index) + buf;
          last = work.length;
          break;
        }
        if (inSi) current.push(unescapeXml(work.slice(re.lastIndex, close)));
        re.lastIndex = close + 4;
        last = re.lastIndex;
      }
    }
    void last;
  }
  if (current.length) push(current.join(''));

  const blob = Buffer.concat(chunks, total);
  const offs = Int32Array.from(offsets);
  return {
    count: offs.length - 1,
    get(i) {
      if (!(i >= 0) || i >= offs.length - 1) return '';
      return blob.toString('utf8', offs[i], offs[i + 1]);
    },
  };
}

/** "BC" -> 54. Column letters are base-26 with no zero. */
export function colIndex(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/**
 * Walk the first worksheet, handing each row to `onRow` as an array of
 * strings. Empty cells are '' and trailing empties are not padded.
 *
 * @param {string} file
 * @param {(cells: string[], rowNumber: number) => void|boolean} onRow
 *   Return false to stop early.
 */
export async function eachRow(file, onRow, { sheet = '' } = {}) {
  const { entries } = zipEntries(file);
  const strings = await readSharedStrings(file, entries);

  const name = sheet || [...entries.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort()[0];
  const entry = entries.get(name);
  if (!entry) throw new Error(`no worksheet in ${file}`);

  let buf = '';
  let rowNo = 0;
  let stopped = false;

  const ROW_RE = /<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g;
  const CELL_RE = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  const V_RE = /<v[^>]*>([\s\S]*?)<\/v>/;
  const IS_RE = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/;

  for await (const chunk of openMember(file, entry)) {
    if (stopped) break;
    buf += chunk.toString('utf8');
    let lastEnd = 0;
    ROW_RE.lastIndex = 0;
    let m;
    while ((m = ROW_RE.exec(buf)) !== null) {
      lastEnd = ROW_RE.lastIndex;
      const attrs = m[1] || '';
      const body = m[2] || '';
      rowNo = Number((attrs.match(/\br="(\d+)"/) || [])[1]) || rowNo + 1;
      const cells = [];
      CELL_RE.lastIndex = 0;
      let c;
      while ((c = CELL_RE.exec(body)) !== null) {
        const cattrs = c[1] || '';
        const inner = c[2] || '';
        const ref = (cattrs.match(/\br="([A-Z]+)\d+"/) || [])[1];
        const type = (cattrs.match(/\bt="([a-zA-Z]+)"/) || [])[1] || 'n';
        let value = '';
        if (type === 'inlineStr') value = unescapeXml((inner.match(IS_RE) || [])[1] || '');
        else {
          const raw = (inner.match(V_RE) || [])[1] ?? '';
          value = type === 's' ? strings.get(Number(raw)) : unescapeXml(raw);
        }
        const at = ref ? colIndex(ref) : cells.length;
        while (cells.length < at) cells.push('');
        cells[at] = value;
      }
      if (onRow(cells, rowNo) === false) { stopped = true; break; }
    }
    // Anything after the last complete </row> belongs to the next chunk.
    buf = lastEnd ? buf.slice(lastEnd) : buf;
    // A pathological run with no row end would grow forever; a sheet row is
    // never megabytes, so this is a corrupt-file guard rather than a limit.
    if (buf.length > 64 * 1024 * 1024) throw new Error('no row boundary in 64 MB — is this a worksheet?');
  }
}

/** Excel's serial date -> ISO day. Serial 1 is 1900-01-01, with the 1900 leap bug. */
export function excelDate(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0) return '';
  const ms = Math.round((n - 25569) * 86400000);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/** A date cell, however the file chose to write it. */
export function cellDate(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d+(\.\d+)?$/.test(s)) return excelDate(s);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}
