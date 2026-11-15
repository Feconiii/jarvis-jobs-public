// jarvis/jd-checklist.mjs — every requirement sentence in a posting, numbered,
// and what on the page proves each one.
//
// WHY (2026-10-27). A blind grade of twelve rebuilt resumes found match flat
// while quality rose: the writer dropped the ONE line that proved a stated
// requirement on some runs (Coherent's CAM ask lost the CNC card-holder
// project; Figure's leadership ask lost "supervise and train 50+"). The
// planner's own coverage list was a paraphrase of the posting it chose to
// list. Now the posting is split here, mechanically, into numbered lines — every
// duty and every required or preferred qualification — the planner must answer
// each by id, and a line cited as proof is kept on the page (resume-plan.mjs
// ensureProofs, withoutOneBullet's protected set). Pure; no model, no I/O.

const SKIP_SECTION = /\b(benefits?|perks|compensation|salary|pay (range|transparency)|about (us|the (company|team)|[A-Z][a-z]+)|who we are|why (join|work)|equal (employment )?opportunity|eeo|accommodations?|privacy|our (values|culture|mission)|company'?s values|life at|what we offer|total rewards|environmental|health,? (and|&) safety|ehs|working conditions|work environment|physical (demands|requirements)|note to (recruiters|agencies))\b/i;
const DUTY = /\b(responsibilit\w*|what you('ll| will)( be)? do|duties|the role|your (impact|role)|in this role|day[- ]to[- ]day|you will|what the job involves|job (description|summary)|key (tasks|accountabilities)|essential functions)\b/i;
const MUST = /\b((minimum|basic|required|essential) (qualifications|requirements|skills)|requirements|(position|role|job) requires|qualifications|what (you('ll)?|we('re)?) (need|look(ing)? for)|must[- ]haves?|you (have|bring|are)|who you are|about you|skills and experience|experience required|education)\b/i;
const NICE = /\b(preferred|nice[- ]to[- ]haves?|bonus( points)?|plus(es)?|desired|additional (qualifications|skills)|ideal(ly)?|stand out|extra credit)\b/i;
/** Lines that are never a requirement he can prove on a page. */
const BOILERPLATE = /\b(equal opportunity|eeo|affirmative action|without regard to|race, colou?r|religion|veteran status|disabilit(y|ies)|accommodation|e-verify|background (check|screen)|drug (test|screen)|salary|base pay|pay range|compensation|\$\s?\d|401\(?k\)?|medical, dental|paid time off|pto|benefits|sponsor(ship)?|visa|work authori[sz]ation|authori[sz]ed to work|u\.?s\.? (person|citizen)|itar|export control|security clearance|lift(ing)? (up to )?\d+|stand(ing)? for|physical demands|privacy (notice|policy)|cookies?|apply now|click here|recruit(ing|ment) (fraud|scam)|(push|pull|sit|bend|squat|kneel)\b.{0,20}\b(lbs|pounds|walk|stand)|work schedule|hours per week|\d+(st|nd|rd|th) shift|first shift|second shift|night shift|work from home|on-?site activities|ehs|site (safety|procedures)|safety and environmental|employment agencies|unsolicited|iso (9000|9001|14001)|pay offered|employment offer|benefit\w*|parental|maternity|leave options|every qualification|we'?d still love|relocation)\b/i;
/** A sentence about the employer, not the job. */
const ABOUT_US = /^([Ww]e|[Oo]ur|[Aa]t [A-Z]|[Jj]oin (us|our)|[Tt]his is an? (exciting|great)|[Ii]t'?s an? (exciting|great)|(?!this\b|the\b|you\b)[A-Z][\w&.]*( [A-Z][\w&.]*)* (is|has been) (a|an|the)\b)/;
/** In a section that is neither duties nor qualifications, only a sentence aimed at the candidate counts. */
const STRONG_CUE = /\b(you will|you('ll| are| have)|experience (in|with)|degree in|bachelor|ability to|knowledge of|required|preferred|proficien(t|cy) (in|with)|familiar(ity)? with)\b/i;
/** A sentence that states something the candidate does or has. */
const CUE = /\b(experience|degree|bachelor|master|b\.?s\.?|ability to|able to|knowledge of|familiar(ity)?|proficien(t|cy)|skills? (in|with)|understanding of|you will|design|develop|build|support|own|lead|drive|work (with|closely)|responsib|collaborat|troubleshoot|analy[sz]e|test|validate|implement|maintain|improve|document|program|install|qualif|specify|create|manage|coordinate|communicat|hands-on|comfortable|strong|excellent|working knowledge|background in|pursuing|graduat)/i;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9+#/ ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** A short line that names a section rather than stating something. */
function headingKind(line) {
  const t = line.replace(/[:\-–—*#|]+\s*$/, '').trim();
  if (t.length > 70 || /[.!?]$/.test(t) && t.split(' ').length > 8) return null;
  if (SKIP_SECTION.test(t) && !MUST.test(t) && !DUTY.test(t)) return 'skip';
  if (NICE.test(t) && /qualif|skills|experience|requirement|have|bonus|plus|desired|ideal/i.test(t)) return 'nice';
  if (MUST.test(t)) return 'must';
  if (DUTY.test(t)) return 'duty';
  return null;
}

/**
 * The posting's requirement lines, numbered: `[{ id: 'R1', text, need }]`, need
 * 'duty' | 'must' | 'nice'. Bullets and short lines are taken whole; a long
 * paragraph is split into sentences. Legal text, pay, benefits, work
 * authorisation and company boilerplate are left out (the visa gate reads
 * those). At most `max` lines, duties and must-haves before nice-to-haves.
 */
export function requirementLines(jd, { max = 40 } = {}) {
  const raw = String(jd || '').replace(/\r/g, '').replace(/[•·▪●◦■]/g, '\n').split('\n');
  const out = [];
  const seen = new Set();
  let section = null;
  let sawSections = false;
  for (let line of raw) {
    line = line.replace(/^\s*([-*–—]|\d+\\?[.)])\s*/, '').trim();
    if (!line) continue;
    const h = headingKind(line);
    if (h) { section = h; sawSections = true; continue; }
    // A short line ending in a colon that names no known section opens one we
    // do not trust ("Hands-on, lab-based job environment:", "Ensure adherence
    // to company's values:"); only candidate-aimed sentences count under it.
    if (/:\s*$/.test(line) && line.length <= 120) { section = 'other'; sawSections = true; continue; }
    if (section === 'skip') continue;
    const parts = line.length > 260 ? line.split(/(?<=[.;!?])\s+(?=[A-Z])/) : [line];
    for (let p of parts) {
      p = p.trim().replace(/\s+/g, ' ');
      if (p.length < 25 || p.length > 420) continue;
      if (BOILERPLATE.test(p) || ABOUT_US.test(p) || /\?\s*$/.test(p) || /^reports? to\b/i.test(p)) continue;
      const inReqSection = section === 'duty' || section === 'must' || section === 'nice';
      if (!inReqSection && !CUE.test(p)) continue;
      if (!inReqSection && sawSections && !STRONG_CUE.test(p)) continue;
      const key = norm(p);
      if (seen.has(key)) continue;
      seen.add(key);
      const need = NICE.test(p) && /\b(preferred|a plus|bonus|nice to have|desired|ideally)\b/i.test(p) ? 'nice'
        : section === 'nice' ? 'nice'
          : section === 'must' ? 'must'
            : section === 'duty' ? 'duty'
              : /\b(required|must|minimum|degree|bachelor)\b/i.test(p) ? 'must' : 'duty';
      out.push({ text: p, need });
    }
  }
  const rank = { must: 0, duty: 1, nice: 2 };
  const kept = out.length <= max ? out
    : out.map((x, i) => ({ x, i })).sort((a, b) => rank[a.x.need] - rank[b.x.need] || a.i - b.i).slice(0, max).sort((a, b) => a.i - b.i).map((y) => y.x);
  return kept.map((x, i) => ({ id: `R${i + 1}`, ...x }));
}

/** What a coverage proof points at: a bullet key, a project, a skill, a course, or nothing. */
export function proofTarget(proof) {
  const p = String(proof || '').trim();
  if (!p || /^none$/i.test(p)) return { kind: 'none', key: null };
  let m = p.match(/^project:\s*(.+)$/i);
  if (m) return { kind: 'project', key: m[1].trim() };
  m = p.match(/^skills?:\s*(.+)$/i);
  if (m) return { kind: 'skills', key: m[1].trim() };
  m = p.match(/^coursework:\s*(.+)$/i);
  if (m) return { kind: 'coursework', key: m[1].trim() };
  if (/^[a-z]+\.[a-z0-9-]+$/i.test(p)) return { kind: 'bullet', key: p };
  return { kind: 'other', key: p };
}

/** Whether a proof is on the finished page. */
export function proofOnPage(target, spec) {
  if (!target || target.kind === 'none') return false;
  if (target.kind === 'bullet') return (spec.experience || []).some((e) => (e.bullets || []).some((b) => b.provenanceKey === target.key));
  if (target.kind === 'project') return (spec.projects || []).some((p) => p.key === target.key || norm(p.lead || p.name) === norm(target.key));
  const text = norm([
    ...(spec.skills || []).map((s) => s.text || ''),
    ...(spec.education || []).flatMap((e) => (e.bullets || []).map((b) => (typeof b === 'string' ? b : b.text || ''))),
    ...(spec.coursework || []),
  ].join(' | '));
  return text.includes(norm(target.key));
}

/**
 * The checklist for a finished page: every numbered requirement, the proof the
 * planner named, and whether that proof made the page. Requirements the planner
 * did not answer come back as `proof: 'unanswered'`.
 */
export function checklist(lines, coverage, spec) {
  const byId = new Map((coverage || []).filter((c) => c && c.id).map((c) => [String(c.id).toUpperCase(), c]));
  return (lines || []).map((l) => {
    const c = byId.get(l.id);
    const proof = c ? String(c.proof || 'none') : 'unanswered';
    const target = proofTarget(c ? proof : 'none');
    const onPage = proofOnPage(target, spec);
    // The planner's own rating, never better than what made the page.
    const strength = !onPage ? 'none' : (c?.strength === 'direct' ? 'direct' : 'partial');
    return { id: l.id, need: l.need, req: l.text, proof, strength, onPage };
  });
}

/** One line for the build report: how many requirement lines the page proves, directly and partly. */
export function checklistLine(list) {
  if (!list?.length) return null;
  const direct = list.filter((x) => x.strength === 'direct').length;
  const partial = list.filter((x) => x.strength === 'partial').length;
  const core = list.filter((x) => x.need !== 'nice');
  const coreDirect = core.filter((x) => x.strength === 'direct').length;
  return `proves ${direct} of ${list.length} requirement lines in the posting directly and ${partial} partly`
    + ` (${coreDirect} of ${core.length} duties and must-haves directly)`;
}

/** Bullet and project keys cited as proof of a duty or must-have, for the layout to keep. */
export function citedKeys(coverage) {
  const bullets = new Set(), projects = new Set();
  for (const c of coverage || []) {
    if (!c || c.need === 'nice') continue;
    const t = proofTarget(c.proof);
    if (t.kind === 'bullet') bullets.add(t.key);
    if (t.kind === 'project') projects.add(t.key);
  }
  return { bullets, projects };
}
