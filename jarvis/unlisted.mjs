// jarvis/unlisted.mjs — a pick its own company's board stopped listing.
//
// "bruh so many postings are dead man" (2026-09-24). The liveness sweep asks
// each posting's ATS directly, and for a third of his picks nothing can answer:
// Tesla refuses servers, and Micron, Applied Materials, Amazon, TSMC and Lam
// run career sites with no per-posting API. But the scanner re-reads every
// tracked company's WHOLE board every six hours, and `last_seen` records each
// posting's last appearance there. Zipline's "HW Test Engineer" was last listed
// 20 days before the board's newest read — the board had dropped it; nothing
// else would ever say so.
//
// So: a pick absent from its company's board for UNLISTED_DAYS while that
// board was read within the last day is retired. Guarded both ways, because a
// false "expired" costs him a real job:
//   · only sources the scanner reads as a whole board — never a LinkedIn,
//     Handshake or browser-assisted row, which no scan refreshes;
//   · never a board big enough that a scan may stop at its page cap (Workday
//     tenants at 1,000), where absence is not evidence;
//   · never a posting he applied to (that record stays as it is);
//   · never a board that now lists FEWER postings than it has dropped — a
//     page that broke mid-read looks like mass closure (onsemi listed 7 and
//     "dropped" 26 on 2026-10-16), and real churn is never that one-sided.
//
// THE DECK TOO (2026-10-16): "why are there so many dead jobs". The rule ran
// on his picks only, so 1,956 Library postings their boards had dropped a week
// or more earlier stayed on the shelf — the API rung cannot reach most of
// them, and it spent its 1,500 a day re-checking the same live top-fit rows.
// A board is its company AND its source: a LinkedIn row seen today does not
// make a Greenhouse board that failed to read "fresh".

export const UNLISTED_DAYS = 7;
export const FRESH_BOARD_DAYS = 1;
export const CAPPED_BOARD = 900;

const NOT_BOARD_SCANNED = /^(linkedin|handshake|browser-assist)/i;
const DAY = 86_400_000;

/**
 * Which picks their boards have stopped listing. Pure: rows in, ids out.
 * @param picks  [{ id, company, last_seen, source, applied_at }]
 * @param boards Map company -> { newest: ISO, recent: number of postings seen within a day of newest }
 */
export function unlistedPicks(picks, boards, { now = Date.now() } = {}) {
  const out = [];
  const perBoard = new Map();
  for (const p of picks) {
    if (p.applied_at) continue;
    if (NOT_BOARD_SCANNED.test(String(p.source || ''))) continue;
    const key = p.board ?? p.company;
    const b = boards.get(key);
    if (!b || !b.newest || !p.last_seen) continue;
    const newest = Date.parse(b.newest);
    if (now - newest > FRESH_BOARD_DAYS * DAY) continue;           // the board itself is not fresh
    if ((b.recent || 0) >= CAPPED_BOARD) continue;                  // a capped board proves nothing
    const gap = (newest - Date.parse(p.last_seen)) / DAY;
    if (gap >= UNLISTED_DAYS) {
      out.push({ id: p.id, days: Math.round(gap), key });
      perBoard.set(key, (perBoard.get(key) || 0) + 1);
    }
  }
  // A board that dropped more than it still lists read short, not empty.
  return out.filter((u) => perBoard.get(u.key) <= (boards.get(u.key).recent || 0))
    .map(({ id, days }) => ({ id, days }));
}

const boardKey = (company, source) => `${company}${source}`;

function readBoards(db, rows) {
  const boards = new Map();
  const newest = db.prepare('SELECT max(last_seen) AS m FROM jobs WHERE company = ? AND source = ?');
  const recent = db.prepare("SELECT count(*) AS n FROM jobs WHERE company = ? AND source = ? AND last_seen >= datetime(?, '-1 day')");
  for (const r of rows) {
    r.board = boardKey(r.company, r.source);
    if (boards.has(r.board)) continue;
    const m = newest.get(r.company, r.source)?.m;
    boards.set(r.board, { newest: m, recent: m ? recent.get(r.company, r.source, m)?.n || 0 : 0 });
  }
  return boards;
}

/** The undecided Library rows and their boards, for the deck sweep. */
export function readDeckAndBoards(db) {
  const picks = db.prepare(`SELECT id, company, title, last_seen, source, applied_at FROM jobs
    WHERE deck = 1 AND gone_at IS NULL`).all();
  return { picks, boards: readBoards(db, picks) };
}

/** Read the picks and their boards from the store (a node:sqlite handle). */
export function readPicksAndBoards(db) {
  const picks = db.prepare(`SELECT id, company, title, last_seen, source, applied_at FROM jobs
    WHERE status IN ('inbox','queued','interested') AND gone_at IS NULL`).all();
  return { picks, boards: readBoards(db, picks) };
}

/**
 * HIS PICKS ALREADY MARKED GONE, read again (F-959 follow-up, 2026-11-03).
 * Every sweep skipped them, so a posting retired on a bad day or reposted on
 * the same URL never came back. Applied rows are included: knowing a posting
 * he applied to is open again is worth knowing.
 */
export function readGonePicksAndBoards(db) {
  const picks = db.prepare(`SELECT id, company, title, url, last_seen, source, applied_at, gone_at FROM jobs
    WHERE status IN ('inbox','queued','interested','applied') AND gone_at IS NOT NULL`).all();
  return { picks, boards: readBoards(db, picks) };
}

/**
 * Which gone picks come back. Pure. Only on the ATS's own word that the
 * posting is ACTIVE, and never one its own fresh board still leaves out —
 * the next sweep's listing check would retire it again, and a card that
 * flickers between open and closed is worse than either.
 * @param verdicts Map id -> { result } from checkLivenessViaApi
 */
// …and only one its board has listed AGAIN since it was retired: a
// GlobalFoundries row last listed in August answered "active" from Workday
// while its board (no longer read daily) could not vouch for it either way.
export function revivedPicks(picks, boards, verdicts, { now = Date.now() } = {}) {
  const unlisted = new Set(unlistedPicks(picks, boards, { now }).map((u) => u.id));
  const listedSince = (p) => p.last_seen && p.gone_at && Date.parse(p.last_seen) > Date.parse(p.gone_at);
  return picks.filter((p) => verdicts.get(p.id)?.result === 'active' && !unlisted.has(p.id) && listedSince(p)).map((p) => p.id);
}

/**
 * Which gone picks to ask this run: least recently asked first (F-960
 * review). A fixed order with a limit rechecked the same first N forever.
 * @param checked { id: ISO time last asked }
 */
export function rotateGonePicks(picks, checked = {}, limit = Infinity) {
  const when = (p) => Date.parse(checked[p.id] || '') || 0;
  return [...picks].sort((a, b) => when(a) - when(b) || String(a.id).localeCompare(String(b.id))).slice(0, limit);
}

/**
 * ANY ROW MARKED GONE THAT ITS BOARD HAS LISTED AGAIN (2026-11-03). The scanner
 * refreshes last_seen every time a board lists a posting, but clears gone_at
 * only when the posted date moves on, so 298 rows sat closed while their board
 * listed them for days (Electra Aero's Airframe Design Engineer, open on its
 * Greenhouse API). The deck sweep asks these the same question as the picks.
 */
export function readGoneListedAgain(db) {
  const picks = db.prepare(`SELECT id, company, title, url, last_seen, source, applied_at, gone_at FROM jobs
    WHERE gone_at IS NOT NULL AND status NOT IN ('inbox','queued','interested','applied','hidden')
      AND julianday(last_seen) - julianday(gone_at) > 1`).all();
  return { picks, boards: readBoards(db, picks) };
}
