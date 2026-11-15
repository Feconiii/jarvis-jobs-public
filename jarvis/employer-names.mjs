// jarvis/employer-names.mjs — one employer's name, compared with another's (F-986 follow-up, 2026-11-04).
//
// A LEAF: it imports nothing from Jarvis. curate.mjs, sponsor-prior.mjs and
// lca-import.mjs all need these two, and when sponsor-prior took them from
// curate.mjs, curate.mjs could not import sponsor-prior back without a loop
// (F-986: a module loaded during curate.mjs's own top-level await waited for it
// forever). Moved here word for word; curate.mjs re-exports both.

const SUFFIX = /\b(inc|incorporated|corp|corporation|co|company|llc|ltd|limited|plc|the|usa|us|u\.s\.|america|americas|north america|international|group|holdings)\b\.?/g;
export const normCo = (n) => String(n || '').toLowerCase().replace(/&amp;/g, '&').replace(SUFFIX, ' ').replace(/[^a-z0-9& ]+/g, ' ').replace(/\s+/g, ' ').trim();

// THE FILER IS THE EMPLOYER, NOT A NAME THAT CONTAINS IT (first mate's review,
// 2026-11-04). "Apple" took Apple Hospitality and Green Apple Capital; "Meta"
// and "Block" took unrelated filers. Now: the same name once legal words are
// gone ("American Honda Motor Company, Inc." = AMERICAN HONDA MOTOR), the same
// letters with spaces dropped ("Super Micro" = Supermicro), or, for a name of
// five letters or more (Cisco Systems, Nokia of America), the other with only generic words after it ("Micron
// Technology" = Micron Technology Inc; not "Micron Technology Utah"). A parent
// that files for its lab (Caltech for JPL) is not guessed: none is found under
// the lab's name, and the card says so.
const GENERIC_TAIL = /^(?:(?:technology|technologies|tech|systems|industries|industrial|enterprises|global|worldwide|services|solutions|of|and|laboratories|labs|associates|partners|partnership|general|com|ai|u|s)\s*)+$/;
export function sameFiler(a, b) {
  const x = String(a || ''), y = String(b || '');
  if (!x || !y) return false;
  if (x === y) return true;
  const sx = x.replace(/ /g, ''), sy = y.replace(/ /g, '');
  if (sx.length >= 6 && sx === sy) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.replace(/ /g, '').length < 5 || !long.startsWith(`${short} `)) return false;
  return GENERIC_TAIL.test(long.slice(short.length + 1).trim());
}
