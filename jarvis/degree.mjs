// jarvis/degree.mjs — does this posting want a degree he does not have?
//
// He wrote the requirement for this module himself, in a skip reason:
//
//   "it needs electrical engineering degree i am mechanical bruh
//    its instant rejection genuinely"
//
// A Micron New College Grad Design Engineer req at fit 95 — the scorer loved
// it, because it is an entry-level design role at a target semiconductor
// employer in a target city. Every dimension said yes. The one sentence that
// decides it ("BS in Electrical Engineering or Computer Engineering") is not a
// dimension anything was reading.
//
// This is the same shape as the graduation-window check: a stated requirement
// he cannot satisfy, which no amount of fit makes winnable. It follows that
// precedent exactly — flagged, quoted, kept in the store, filtered out of the
// deck, and reachable through "All incl. blocked".
//
// THE FAILURE MODE THAT MATTERS
// ─────────────────────────────
// A false mismatch hides a job he could have got, which is the expensive error
// (Product Law #1). So the bar for claiming a mismatch is deliberately high:
//
//   · A requirement must NAME disciplines. "Bachelor's degree in Engineering",
//     "a technical degree", "STEM degree" name none, so they never mismatch.
//   · If ANY named discipline is one of his, it is a match — most reqs list
//     three or four alternatives and one of them is usually Mechanical.
//   · "or related field", "or equivalent", "or similar" makes the list open,
//     and an open list is never a mismatch.
//   · Silence is a match. Most postings never state a discipline at all.
//
// Only a closed list that names disciplines and excludes all of his counts.

/** Disciplines that read as "he qualifies", from a BSME's perspective. */
const HIS_DISCIPLINES = [
  'mechanical', 'mechanical engineering', 'me',
  'manufacturing', 'manufacturing engineering',
  'industrial', 'industrial engineering', 'ie',
  'mechatronics', 'robotics', 'automation',
  'aerospace', 'aeronautical', 'astronautical',
  'materials', 'materials science', 'metallurgy', 'metallurgical',
  'engineering technology', 'mechanical engineering technology',
  'manufacturing technology', 'industrial technology',
  'systems engineering', 'engineering management',
  'physics', 'applied physics', 'engineering physics',
];

/**
 * Disciplines that are decidedly NOT his, split by how far away they are —
 * because "or a related field" means related TO WHAT WAS NAMED, not "anything".
 *
 * This distinction is the whole reason 1,230 ASIC/SoC/RFIC postings sat in his
 * deck. They all say some version of "BS or MS in Computer Science, Electrical
 * Engineering, Computer Engineering or related discipline", and treating any
 * open list as unrestricted let every one of them through. A mechanical
 * engineer is not a discipline related to ASIC design.
 *
 * FAR — the escape hatch cannot reach him. A list of only these is a mismatch
 * even when it says "or related field".
 */
const FAR_DISCIPLINES = [
  'electrical', 'electrical engineering', 'ee',
  'electronics', 'electronic engineering', 'microelectronics',
  'computer science', 'cs', 'computer engineering', 'ce',
  'software engineering', 'information technology', 'information systems',
  'nursing', 'pharmacy', 'accounting', 'finance', 'marketing',
  'human resources', 'business administration', 'economics',
  'law', 'journalism', 'graphic design',
];

/**
 * ADJACENT — not his, but close enough that "or a related field" plausibly
 * includes him. A fab process role asking for Chemical Engineering "or a
 * related field" really does hire mechanical engineers; an ASIC role asking
 * for EE "or related" really does not.
 */
const ADJACENT_DISCIPLINES = [
  'chemical', 'chemical engineering', 'cheme',
  'civil', 'civil engineering', 'structural engineering',
  'biomedical', 'bioengineering', 'biology', 'biochemistry', 'chemistry',
  'petroleum', 'mining', 'nuclear engineering', 'agricultural',
  'environmental engineering', 'geology', 'engineering science',
];

const OTHER_DISCIPLINES = [...FAR_DISCIPLINES, ...ADJACENT_DISCIPLINES];

// Where a degree requirement is stated. Captures the phrase AFTER "degree in"
// / "BS in" so the discipline list can be read out of it.
const REQUIREMENT_RE = new RegExp(
  // F-507: the dotted forms carry their own ending. `b\.s\.\b` can never match
  // "B.S. in" — there is no word boundary between a full stop and a space — so
  // "B.S. or M.S. in Mechanical Engineering" was not read as a requirement.
  String.raw`(?:(?:\b(?:bachelor'?s?|master'?s?|bs|ba|ms|phd|doctorate|degree|major)\b|\b[bm]\.\s?(?:sc|s|a|eng)\.?|\bph\.\s?d\.?)` +
  String.raw`(?:(?:,?\s*or\s+|\s*/\s*)(?:[bm]\.\s?(?:sc|s|a|eng)\.?|ph\.\s?d\.?))*[^.\n]{0,40}?)` +
  String.raw`\bin\s+([^.;\n]{3,180})`,
  'ig',
);

// An open-ended list cannot exclude him, however it is punctuated.
//
// The first version only caught the escape hatch when it followed "or", and
// GlobalFoundries writes it after a comma: "Master's degree in Chemical
// Engineering, a related field, or a foreign equivalent". That read as a
// closed ChemE-only list and would have hidden the req. The opener does not
// matter — "related field" anywhere inside the requirement means the list is
// open, so match the phrase itself rather than the conjunction in front of it.
const OPEN_ENDED_RE = new RegExp([
  String.raw`\b(?:a\s+|an\s+)?(?:closely[- ])?(?:related|similar|relevant|comparable|allied|associated|equivalent|adjacent)\s+(?:field|discipline|area|major|degree|subject|study|studies|program)s?\b`,
  String.raw`\b(?:or|and)\s+(?:a\s+)?(?:related|similar|equivalent|relevant|other|comparable|allied|associated)\b`,
  String.raw`\b(?:foreign|international)\s+equivalent\b`,
  String.raw`\bor\s+equivalent\b`,
  String.raw`\bequivalent\s+(?:experience|work\s+experience|practical\s+experience)\b`,
  String.raw`\betc\.?\b`,
  String.raw`\bsuch\s+as\b`,
  String.raw`\bincluding\b`,
  String.raw`\bany\s+engineering\b`,
  String.raw`\bfields?\s+of\s+study\b`,
].join('|'), 'i');

// A requirement that offers a bachelor's route anywhere in it. "BS or MS in X"
// is open to him; "Master's degree in X" is not.
const BACHELOR_OK_RE = /(?:\b(?:bachelor'?s?|BS|BA|BSc|undergraduate|four[- ]year degree)\b|\bB\.\s?(?:Sc|S|A|Eng)(?![a-z]))/i;

// A requirement that names ONLY a graduate degree.
const GRADUATE_ONLY_RE = /(?:\b(?:master'?s?|MS|MSc|PhD|doctorate|doctoral|graduate degree|advanced degree)\b|\bM\.\s?(?:S|Sc|Eng)\.(?!\w)|\bPh\.\s?D\.?(?!\w))/i;

// "Master" as a noun in a job title — Master Production Control Planner,
// Master Scheduler, Master Data Analyst. Not a degree level.
const MASTER_NOUN_RE = /\bmaster\s+(?:production|scheduler?|schedul|data|planner?|plan|black belt|electrician|technician|craftsman|builder)/i;

// A phrase that OPENS with a generic container and then gives examples —
// "a technical discipline such as Electrical Engineering". The named
// discipline is an illustration, not the requirement, so the far/adjacent
// reasoning must not apply to it.
const GENERIC_CONTAINER_RE = /^(?:an?|the)?\s*(?:technical|scientific|stem|engineering|quantitative|numerate|relevant)\s+(?:field|discipline|degree|area|major|background|subject|study|studies)/i;

// Phrases that name no discipline at all, so nothing can be excluded.
const GENERIC_RE = /^(?:an?\s+)?(?:engineering|a\s+technical\s+\w+|technical\s+\w+|stem|science|a\s+related\s+\w+|any\s+\w+)\s*$/i;

const reCache = new Map();
function termRe(term) {
  let re = reCache.get(term);
  if (re) return re;
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  re = new RegExp(`(^|[^a-z])${esc}([^a-z]|$)`, 'i');
  reCache.set(term, re);
  return re;
}

/** Split "Mechanical, Electrical or Industrial Engineering" into disciplines. */
function splitDisciplines(phrase) {
  return String(phrase)
    .replace(/\bengineering\b/ig, ' engineering ')
    .split(/\s*(?:,|\/|\bor\b|\band\b|\||;)\s*/i)
    .map(s => s.replace(/\b(?:a|an|the|degree|field|discipline|study|studies|related)\b/ig, ' ').trim())
    .filter(s => s.length >= 2 && s.length <= 60);
}

// ── A PREFERENCE IS NOT A REQUIREMENT (F-507) ──────────────────────────
// Agility Robotics, Mechanical Engineer, Fremont, 0-3 years, fit 100: the
// minimum was "B.S. or M.S. in Mechanical Engineering", and "Advanced degree in
// engineering or science or robotics" sat under "Preferred Skills and
// Experience:". The preferred bullet was read as the requirement and the job
// left his deck. A line that only states what would be nice can never make a
// posting unwinnable, whatever level or discipline it names.
const PREFERRED_HEAD_RE = /\b(?:preferred|preferences|desired|desirable|bonus|nice[- ]to[- ]haves?|good[- ]to[- ]haves?|plus(?:es)?|extra credit|stand out|sets? you apart|even better|ideal(?:ly)?)\b/i;
const REQUIRED_HEAD_RE = /\b(?:required|requirements?|minimum|basic|must[- ]haves?|qualifications|essential|what you(?:'|’)ll need|who you are|about you|what you bring|you have)\b/i;
const INLINE_PREF_RE = /\b(?:preferred|a (?:strong |big |definite )?plus|nice[- ]to[- ]have|bonus|desired|desirable|ideally|advantageous|an asset|not required|but not necessary)\b/i;
const INLINE_REQ_RE = /\b(?:required|requirement|minimum|must)\b/i;
const BULLET_LEAD_RE = /^\s*(?:[•*·|>–—-]|o\s)\s*/;

/** Does the nearest heading above `index` open a preferred / nice-to-have section? */
function underPreferredHeading(text, index) {
  const before = text.slice(Math.max(0, index - 2500), index);
  const lines = before.split(/\r?\n/);
  lines.pop(); // the line the requirement itself is on
  if (lines.length) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const raw = lines[i];
      if (!raw.trim()) continue;
      const bulleted = BULLET_LEAD_RE.test(raw);
      const line = raw.replace(BULLET_LEAD_RE, '').trim();
      if (!line || line.length > 70) continue;
      const colon = /[:：]$/.test(line);
      const words = line.split(/\s+/).length;
      const heading = colon || (!bulleted && words <= 5 && !/[.,;]$/.test(line));
      if (!heading) continue;
      if (PREFERRED_HEAD_RE.test(line)) return true;
      // Any other heading closes whatever section came before it.
      if (REQUIRED_HEAD_RE.test(line) || colon) return false;
    }
    return false;
  }
  // Flattened body, no line breaks to read: the last "Label:" before it.
  const LABEL_RE = /([A-Za-z][A-Za-z'’ /&-]{2,60})[:：]/g;
  let last = null, m;
  while ((m = LABEL_RE.exec(before)) !== null) last = m[1];
  return !!last && PREFERRED_HEAD_RE.test(last);
}

function isPreference(text, index, sentence) {
  const s = String(sentence || '');
  if (INLINE_PREF_RE.test(s) && !INLINE_REQ_RE.test(s.replace(/not required/ig, ''))) return true;
  return underPreferredHeading(text, index);
}

/**
 * Read a posting's degree requirement.
 *
 * @param {string} description
 * @returns {{mismatch:boolean, wanted:string[], quote:string|null}}
 *   mismatch — true only for a CLOSED list that names disciplines, none his
 *   wanted   — the disciplines the posting named
 *   quote    — the sentence that decided it, for the card to show verbatim
 */
export function checkDegree(description, title = '') {
  const text = String(description || '');
  const head = String(title || '');

  // ── LEVEL ──────────────────────────────────────────────────────────
  // He is a BS. A req that only offers a Master's or a PhD is unwinnable
  // however well the discipline lines up, and Applied Materials publishes the
  // level right in the title: "Mechanical Engineer New College Grad Doctorate
  // Degree", "Mechanical Engineer Phd Early In Career".
  if (head && GRADUATE_ONLY_RE.test(head) && !BACHELOR_OK_RE.test(head) && !MASTER_NOUN_RE.test(head)) {
    return {
      mismatch: true, reason: 'level', wanted: ["a graduate degree"],
      quote: head.trim().slice(0, 240),
    };
  }

  if (!text) return { mismatch: false, reason: null, wanted: [], quote: null };

  REQUIREMENT_RE.lastIndex = 0;
  let m;
  // A posting can state several requirements ("BS in ME" for one track,
  // "BS in EE" for another). Any single satisfiable one makes the job
  // winnable, so a match anywhere wins outright.
  const candidates = [];
  let levelHit = null;
  while ((m = REQUIREMENT_RE.exec(text)) !== null) {
    const phrase = m[1];
    const sentence = sentenceAround(text, m.index);
    if (isPreference(text, m.index, sentence)) continue;

    // Graduate-only requirement, read from the sentence rather than the
    // captured phrase: "Master's degree in X" puts the level before "in".
    if (GRADUATE_ONLY_RE.test(sentence) && !BACHELOR_OK_RE.test(sentence)) {
      if (!levelHit) levelHit = { wanted: ['a graduate degree'], quote: sentence };
    }

    // The level check has to survive a discipline match. A "PhD in Robotics"
    // names a discipline that IS his, and returning "fine" on that basis
    // handed him a doctorate-only req — right subject, unreachable level.
    const gradOnlyHere = GRADUATE_ONLY_RE.test(sentence) && !BACHELOR_OK_RE.test(sentence);

    if (GENERIC_RE.test(phrase.trim()) || GENERIC_CONTAINER_RE.test(phrase.trim())) {
      if (gradOnlyHere) continue;
      return { mismatch: false, reason: null, wanted: [], quote: null };
    }

    const parts = splitDisciplines(phrase);
    const his = parts.filter(pt => HIS_DISCIPLINES.some(h => termRe(h).test(pt)));
    if (his.length) {
      if (gradOnlyHere) continue;
      return { mismatch: false, reason: null, wanted: parts, quote: null };
    }

    const far = parts.filter(pt => FAR_DISCIPLINES.some(o => termRe(o).test(pt)));
    const adjacent = parts.filter(pt => ADJACENT_DISCIPLINES.some(o => termRe(o).test(pt)));
    const open = OPEN_ENDED_RE.test(phrase);

    // "or a related field" means related TO WHAT WAS NAMED. When everything
    // named is far from mechanical — Computer Science, Electrical Engineering,
    // Computer Engineering — the escape hatch does not reach him, and treating
    // it as if it did left 1,230 ASIC/SoC/RFIC postings in his deck.
    //
    // When something ADJACENT is named (a fab process role asking for Chemical
    // Engineering "or a related field"), it plausibly does reach him, and the
    // posting stays.
    if (open && (adjacent.length || !far.length)) {
      return { mismatch: false, reason: null, wanted: parts, quote: null };
    }

    if (far.length || adjacent.length) {
      candidates.push({ wanted: [...far, ...adjacent], quote: sentence });
    }
  }

  if (candidates.length) {
    return { mismatch: true, reason: 'discipline', wanted: candidates[0].wanted, quote: candidates[0].quote };
  }
  // A level block stands only when no bachelor's route is offered anywhere.
  // Micron: "M.S. or Ph.D. in … * B.S. with 3+ years … will also be considered";
  // KLA: "Master's Level Degree and 0 years; Bachelor's Level Degree and 2 years".
  // Those routes are rarely phrased as "degree in X", so the whole body is read.
  if (levelHit && !BACHELOR_OK_RE.test(text)) {
    return { mismatch: true, reason: 'level', wanted: levelHit.wanted, quote: levelHit.quote };
  }
  return { mismatch: false, reason: null, wanted: [], quote: null };
}

/**
 * The sentence containing `index`, trimmed for display.
 *
 * Job descriptions are mostly bullet lists, not prose. Splitting on '.' alone
 * quoted a run-on fragment about serializers and ZQ calibration for the Micron
 * req — the requirement was a bullet, and the nearest full stops were hundreds
 * of characters away in unrelated items. Bullet markers and newlines end a
 * "sentence" here too.
 */
const BOUNDARY = /[.\n\r*•·|;]/;
// The full stops inside "B.S.", "M.S." and "Ph.D." end nothing.
function isBoundary(text, i) {
  if (!BOUNDARY.test(text[i])) return false;
  if (text[i] !== '.') return true;
  const head = text.slice(Math.max(0, i - 5), i);
  return !/(?:^|[^A-Za-z])(?:[A-Za-z]|Ph|[BM]\.\s?[A-Za-z]{1,3}|Ph\.\s?D)$/.test(head);
}
function sentenceAround(text, index) {
  let start = 0;
  for (let i = index; i > 0; i--) {
    if (isBoundary(text, i)) { start = i + 1; break; }
  }
  let end = text.length;
  for (let i = index; i < text.length; i++) {
    if (isBoundary(text, i)) { end = i; break; }
  }
  const out = text.slice(start, end).replace(/\s+/g, ' ').trim();
  // A boundary can land mid-requirement ("B.S. in EE" splits on the dots), so
  // a scrap that short is not a usable quote — widen rather than show noise.
  if (out.length < 24) {
    return text.slice(Math.max(0, index - 90), Math.min(text.length, index + 130))
      .replace(/\s+/g, ' ').trim().slice(0, 240);
  }
  return out.slice(0, 240);
}

export const _internals = { HIS_DISCIPLINES, OTHER_DISCIPLINES, splitDisciplines, sentenceAround };
