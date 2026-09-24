// jarvis/proofread.mjs — the literal mistakes a proofreader would circle.
//
// His words, 2026-09-23: "im conerned with layout issues and literal mistakes
// and grammar in the resume, 6 d0f should be 6-dof". A proofread of the fifty
// most recently SENT resumes found no misspellings but a steady set of slips —
// "on robotic assembly line", "combined into animated assembly", "an issue
// reducing jams", a bullet with no period on a page where every other bullet
// has one, "Fall 2023 - Spring 2026" beside "May 2026 – August 2026" — nearly
// all of them in the bullet pool, so each one repeated on every page that used
// the bullet.
//
// Only what a rule can decide without guessing is here. A missing article in
// general cannot be caught by a pattern without false alarms, so the pool is
// fixed by hand and the writer is told the rule; this file catches the rest.
// It is used three ways: a test keeps the pool clean, the rewrite guard refuses
// a rewrite that fails it (the pool wording then stands), and the checklist on
// every finished page carries it.

const VOWEL_SOUND_LETTERS = new Set('AEFHILMNORSX');   // letters said with a vowel sound: "an FEA", "an SMT"

/**
 * Problems in one piece of resume text. `kind` is 'bullet' (a sentence that
 * must start with a capital and end with a period) or 'text' (anything else).
 * Returns a list of plain sentences, empty when clean.
 */
export function proofread(text, { kind = 'bullet' } = {}) {
  const s = String(text || '');
  const out = [];
  if (!s.trim()) return out;
  const found = (re) => s.match(re);

  if (kind === 'bullet') {
    if (!/[.]$/.test(s.trim())) out.push('does not end with a period');
    if (/^[a-z]/.test(s.trim())) out.push('starts with a lowercase letter');
  }
  let m;
  if ((m = found(/\b\d+\s+DOF\b/i))) out.push(`"${m[0]}" should be hyphenated ("${m[0].replace(/\s+/, '-').toUpperCase()}")`);
  if ((m = found(/\b(?:(?:Spring|Summer|Fall|Autumn|Winter|January|February|March|April|May|June|July|August|September|October|November|December)\s+)?(?:19|20)\d\d\s+-\s+\S+/))) {
    out.push(`"${m[0]}" uses a hyphen for a range — use an en dash (–)`);
  }
  if ((m = found(/\b(\w{2,})\s+\1\b/i)) && !/^\d+$/.test(m[1])) out.push(`"${m[0]}" repeats a word`);
  if (/ {2,}/.test(s)) out.push('has a double space');
  if ((m = found(/\s[,.;:!?)]/))) out.push(`space before "${m[0].trim()}"`);
  if (/\(\s/.test(s)) out.push('space after "("');
  const opens = (s.match(/\(/g) || []).length;
  const closes = (s.match(/\)/g) || []).length;
  if (opens !== closes) out.push('unbalanced parentheses');

  // a / an. Lowercase words by their first letter (o and u are left alone:
  // "a one-piece", "a unit", "a user"); acronyms by how the letter is said.
  for (const mm of s.matchAll(/\b(a|an|A|An)\s+([A-Za-z][\w&/-]*)/g)) {
    const [whole, art, word] = mm;
    const an = art.toLowerCase() === 'an';
    const acronym = /^[A-Z]{2,}/.test(word) || /^[A-Z]&[A-Z]/.test(word);
    let wantAn;
    if (acronym) wantAn = VOWEL_SOUND_LETTERS.has(word[0]);
    else if (/^[aei]/i.test(word)) wantAn = true;
    else if (/^[ou]/i.test(word)) continue;
    else if (/^h/i.test(word)) continue;           // "an hour", "a high-precision"
    else wantAn = false;
    if (an !== wantAn) out.push(`"${whole}" should be "${wantAn ? 'an' : 'a'} ${word}"`);
  }

  // The dangling result: an issue does not reduce jams, its fix does. Seen on
  // 45 of 50 sent resumes as "identified a magazine feeding issue reducing jams".
  if ((m = found(/\b(?:issue|problem|bottleneck|defect|failure|error|jam)s?,?\s+(?:reducing|cutting|improving|increasing|saving|eliminating)\b/i))) {
    out.push(`"${m[0]}" reads as the ${m[0].split(/[\s,]/)[0].toLowerCase()} doing it — say what the fix did`);
  }
  return out;
}

/**
 * Every literal mistake on a built spec, labelled by where it sits. Experience
 * and project bullets are sentences; education lines and skills are lists.
 */
export function proofreadSpec(spec) {
  const out = [];
  const add = (where, text, kind) => { for (const p of proofread(text, { kind })) out.push({ where, text: String(text), problem: p }); };
  for (const e of spec?.experience || []) {
    for (const b of e.bullets || []) add(e.org || e.orgKey || 'experience', typeof b === 'string' ? b : b.text, 'bullet');
  }
  for (const p of spec?.projects || []) add(`project ${p.name || p.lead || ''}`.trim(), p.text, 'bullet');
  for (const ed of spec?.education || []) {
    for (const b of ed.bullets || []) add('education', typeof b === 'string' ? b : `${b.lead || ''}: ${b.text || ''}`, 'text');
    add('education', ed.degree, 'text');
  }
  for (const s of spec?.skills || []) add('skills', `${s.lead || ''}: ${s.text || (s.items || []).join(', ')}`, 'text');
  return out;
}
