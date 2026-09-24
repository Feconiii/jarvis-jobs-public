#!/usr/bin/env node
/**
 * The xlsx reader, against .xlsx files this test BUILDS.
 *
 * Writing the fixture rather than checking one in is the point: an .xlsx is a
 * ZIP of XML, so a test that can write one proves the reader against the real
 * container format — deflate, central directory, shared strings and all —
 * without a binary blob in the repo or a 200 MB download in CI.
 *
 * The cases are the ones that actually break a hand-rolled reader:
 *   · a cell value split across rich-text runs (one <si>, several <t>)
 *   · a gap in the columns, so cells must be placed by their ref not counted
 *   · a row that straddles the 1 MB read boundary
 *   · XML entities, which appear in real employer names ("JOHNSON & JOHNSON")
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import { eachRow, colIndex, excelDate, cellDate, unescapeXml, zipEntries } from './xlsx.mjs';

let pass = 0, fail = 0;
const check = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return; }
  fail++;
  console.error(`✗ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
};

// ── a minimal ZIP writer, so the fixture is a real archive ──────────
function zip(files, { store = false } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, 'utf8');
    const body = store ? data : deflateRawSync(data);
    const crc = crc32(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(store ? 0 : 8, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(store ? 0 : 8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cen = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cen.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cen, eocd]);
}

const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-xlsx-'));
const build = (file, sheetXml, sharedXml, opts) => {
  const p = path.join(dir, file);
  writeFileSync(p, zip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
    ['xl/sharedStrings.xml', sharedXml],
    ['xl/worksheets/sheet1.xml', sheetXml],
  ], opts));
  return p;
};

const readAll = async (file) => { const rows = []; await eachRow(file, (c) => { rows.push(c); }); return rows; };

// ── 1. the shapes a spreadsheet actually writes ─────────────────────
console.log('🧪 xlsx: the cell types a machine-generated sheet contains');

const SHARED = `<?xml version="1.0"?><sst count="6" uniqueCount="6">
<si><t>EMPLOYER_NAME</t></si>
<si><t>PW_WAGE_LEVEL</t></si>
<si><t>APPLIED MATERIALS, INC.</t></si>
<si><t>Level </t><t>II</t></si>
<si><t>JOHNSON &amp; JOHNSON</t></si>
<si><t>MICRON TECHNOLOGY, INC.</t></si>
</sst>`;
const SHEET = `<?xml version="1.0"?><worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>
<row r="3"><c r="A3" t="s"><v>4</v></c><c r="C3"><v>135000</v></c></row>
<row r="4"><c r="A4" t="s"><v>5</v></c><c r="B4" t="inlineStr"><is><t>Level I</t></is></c></row>
</sheetData></worksheet>`;

const rows = await readAll(build('basic.xlsx', SHEET, SHARED));
check('every row is read', rows.length, 4);
check('the header comes back', rows[0], ['EMPLOYER_NAME', 'PW_WAGE_LEVEL']);
check('A SHARED STRING SPLIT ACROSS RUNS IS ONE VALUE', rows[1][1], 'Level II');
check('…and the index after it has not shifted', rows[2][0], 'JOHNSON & JOHNSON');
check('XML entities are decoded', rows[2][0].includes('&'), true);
check('A GAP IN THE COLUMNS IS PLACED BY REF, NOT COUNTED', rows[2], ['JOHNSON & JOHNSON', '', '135000']);
check('an inline string is read', rows[3][1], 'Level I');

// A stored (uncompressed) member reads the same as a deflated one.
const stored = await readAll(build('stored.xlsx', SHEET, SHARED, { store: true }));
check('a stored member reads identically', stored, rows);

// ── 2. the boundary a streaming reader gets wrong ───────────────────
console.log('🧪 xlsx: a row that straddles the read boundary');

// Rows are handed over in 1 MB chunks; a reader that does not hold back the
// tail loses or splits whatever lands on the seam. 40,000 rows is several
// megabytes of sheet, so the seam is crossed many times.
const N = 40000;
const bigShared = `<?xml version="1.0"?><sst><si><t>ACME ${'X'.repeat(60)} CORP</t></si><si><t>Level IV</t></si></sst>`;
let body = '';
for (let i = 1; i <= N; i++) {
  body += `<row r="${i}"><c r="A${i}" t="s"><v>0</v></c><c r="B${i}" t="s"><v>1</v></c><c r="C${i}"><v>${100000 + i}</v></c></row>`;
}
const bigFile = build('big.xlsx', `<?xml version="1.0"?><worksheet><sheetData>${body}</sheetData></worksheet>`, bigShared);

let seen = 0; let firstBad = null; let lastWage = '';
await eachRow(bigFile, (cells, n) => {
  seen++;
  if (cells.length !== 3 || !cells[0].startsWith('ACME') || cells[1] !== 'Level IV') firstBad = firstBad ?? { n, cells };
  lastWage = cells[2];
});
check('every row across every chunk boundary is read', seen, N);
check('…and none of them is malformed', firstBad, null);
check('…the last row is intact', lastWage, String(100000 + N));

// Stopping early actually stops.
let counted = 0;
await eachRow(bigFile, () => { counted++; return counted < 10 ? undefined : false; });
check('returning false stops the walk', counted, 10);

// ── 3. the small pure pieces ────────────────────────────────────────
console.log('🧪 xlsx: columns, dates and entities');
check('column A is 0', colIndex('A1'), 0);
check('column Z is 25', colIndex('Z9'), 25);
check('column AA is 26', colIndex('AA100'), 26);
check('column BC is 54', colIndex('BC2'), 54);
// 45658 is 2025-01-01, so 45678 is the 21st. Checked against Excel's own epoch
// rather than guessed: the first version of this line expected the 15th and the
// READER was right.
check('an Excel serial becomes a date', excelDate(45678), '2025-01-21');
check('…and the new year it is counted from', excelDate(45658), '2025-01-01');
check('a date cell already written as text is left alone', cellDate('2026-03-04'), '2026-03-04');
check('…and one written as a serial is converted', cellDate('45678'), '2025-01-21');
check('an empty date cell is empty, not epoch', cellDate(''), '');
check('a numeric entity decodes', unescapeXml('A&#38;B'), 'A&B');

// ── 4. the archive itself ───────────────────────────────────────────
console.log('🧪 xlsx: the container');
const { entries } = zipEntries(bigFile);
check('the members are listed', [...entries.keys()].includes('xl/worksheets/sheet1.xml'), true);
check('…with their compressed size', entries.get('xl/worksheets/sheet1.xml').compressed > 0, true);

try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp, it can wait */ }

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
