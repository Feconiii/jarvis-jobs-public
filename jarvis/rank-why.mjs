// jarvis/rank-why.mjs — why a pick sits where it does, from his own rules (2026-11-03).
//
// The Inbox is ordered by fit, and fit is built from named parts: role,
// skills, seniority, industry, pay, place, plus the adjustments his
// preferences.md lines make. He chose "suggest rules, I approve" over a learned
// ranking, so the order stays explained only by what he can read and change.
// This puts that explanation on the card: the parts that carried the score,
// what held it back, and which of his lines moved it.

/** One line from scoreFit's breakdown: "fit 92 — role 28/28 (…) · skills 26/26 (…) · your rules +12 (…)". */
export function rankWhy(fit) {
  if (!fit || !Array.isArray(fit.breakdown)) return null;
  const parts = [];
  const judged = fit.breakdown.filter((b) => b.judged && !b.adjustment && b.max > 0);
  const short = (s) => String(s || '').replace(/^(Title is |Asks for |In |Matches what you want: )/i, '').replace(/\s+—.*$/, '').slice(0, 60);
  // What carried it: the two parts with the most points.
  for (const b of [...judged].sort((a, c) => c.points - a.points).slice(0, 2)) parts.push(`${b.dimension} ${b.points}/${b.max}${b.why?.[0] ? ` (${short(b.why[0])})` : ''}`);
  // What held it back: the part furthest below its maximum, if it lost points.
  const weak = [...judged].sort((a, c) => (a.points / a.max) - (c.points / c.max))[0];
  if (weak && weak.points < weak.max && !parts.some((p) => p.startsWith(`${weak.dimension} `))) parts.push(`held back by ${weak.dimension} ${weak.points}/${weak.max}${weak.why?.[0] ? ` (${short(weak.why[0])})` : ''}`);
  // His own lines that moved it.
  const rules = fit.breakdown.find((b) => b.adjustment);
  if (rules && rules.points) parts.push(`your rules ${rules.points > 0 ? '+' : ''}${rules.points}${rules.why?.length ? ` (${rules.why.slice(0, 3).map(short).join(', ')})` : ''}`);
  return parts.length ? `fit ${fit.score} — ${parts.join(' · ')}` : null;
}
