// jarvis/field.mjs — what industry a posting actually belongs to.
//
// `profile.yml` lists target industries, and fit.mjs used to score them as a
// yes/no: any target industry matched → 10/10, otherwise 5/10. That is fine for
// deciding whether a job is *relevant* and useless for deciding what to show
// first, because it makes a wafer-fab equipment role and a humanoid-robotics
// role score identically.
//
// It does not matter in a store that is evenly spread across industries. This
// one is not: 383 tracked companies are overwhelmingly semiconductor, so the
// top of the deck was 31 GlobalFoundries reqs out of 100 and browsing it meant
// reading the same fab job over and over.
//
// So a posting gets classified into a field, and the fields he is actively
// hunting outrank the ones he merely qualifies for. The signal is deliberately
// weak — two points out of a hundred — because the ordering fix for employer
// monotony belongs in the deck, not in a thumb on the score. This exists so a
// robotics role can *break a tie* against a fab role, not so it can leapfrog a
// better-matched one.
//
// Matching is literal, word-boundary keywords. No model, no tokens, no network.

/**
 * Fields he is actively hunting — these score full marks.
 *
 * Space was here until 2026-08-22 and is deliberately gone. It is the most
 * export-controlled sector there is, and the postings never say so: all 35
 * space reqs in the deck stated nothing about ITAR or US-person status and
 * none were work-auth blocked. Boosting a field he legally cannot work in was
 * surfacing dead ends at the top of the deck. `preferences.md` now blocks the
 * space vocabulary outright; the classifier keeps the label so a space posting
 * is still recognisable when he goes looking under "All incl. blocked".
 */
export const PRIORITY_FIELDS = ['robotics', 'ai-hardware'];

/**
 * Field definitions, most specific first. `weight` breaks ties when a posting
 * mentions several: a robot company that also says "semiconductor" once is
 * still a robotics job.
 */
const FIELDS = [
  {
    key: 'robotics',
    label: 'Robotics & autonomy',
    weight: 5,
    terms: [
      'robotics', 'robotic', 'humanoid', 'cobot', 'collaborative robot',
      'autonomous mobile robot', 'amr', 'agv', 'autonomous vehicle', 'self-driving',
      'motion planning', 'manipulation', 'end effector', 'end-effector',
      'actuator', 'kinematics', 'ros2', 'moveit', 'teleoperation',
      'drone', 'uav', 'quadruped', 'exoskeleton', 'mechatronics',
    ],
  },
  {
    key: 'ai-hardware',
    label: 'AI hardware & datacenter',
    weight: 4,
    terms: [
      'data center', 'datacenter', 'liquid cooling', 'immersion cooling',
      'cold plate', 'thermal management', 'rack integration', 'server rack',
      'gpu cluster', 'accelerator hardware', 'ai infrastructure',
      'hyperscale', 'power distribution unit', 'busway', 'cdu',
      'compute hardware', 'ai datacenter', 'ai data center',
    ],
  },
  {
    key: 'space',
    label: 'Space & launch',
    weight: 5,
    // Every term here must be unambiguous ON ITS OWN, because a single match
    // is enough to claim the posting. The first draft used bare "satellite",
    // "propulsion" and "orbital", which classified CVS Health and Cardinal
    // Health pharmacy roles as space work (satellite *pharmacy*), General
    // Motors as space work (automotive *propulsion*), and a stack of Applied
    // Materials reqs along with them. A field filter that surfaces a pharmacy
    // job under 🚀 is worse than no filter at all.
    terms: [
      'spacecraft', 'launch vehicle', 'cubesat', 'smallsat',
      'space systems', 'rocket engine', 'rocket propulsion', 'space propulsion',
      'electric propulsion', 'cryogenic propellant', 'payload fairing',
      'orbital mechanics', 'low earth orbit', 'in-orbit', 'on-orbit', 'in-space',
      'satellite constellation', 'satellite bus', 'satellite payload',
      'reaction control', 'star tracker', 'deorbit',
      // Rocket-engine vocabulary. Unambiguous on its own and nothing else
      // uses it — tightening the list to kill the "satellite pharmacy" false
      // positives had also dropped Relativity's "Propulsion Manufacturing
      // Engineer II, Combustion Devices" on the floor.
      'combustion device', 'thrust chamber', 'turbopump', 'engine test stand',
      // NOT 'launch site': Amazon's relocation boilerplate says "must be
      // located outside of 50 miles from the launch site", meaning a new
      // warehouse launch. It filed Dock Clerk and Hazmat Waste Coordinator
      // under space.
    ],
  },
  {
    key: 'semiconductor',
    label: 'Semiconductor',
    weight: 3,
    terms: [
      'semiconductor', 'wafer', 'fab ', 'foundry', 'lithography', 'etch',
      'deposition', 'cmp', 'metrology', 'cleanroom', 'clean room',
      'ion implant', 'photoresist', 'euv', 'die attach', 'wafer fab',
      'front end of line', 'back end of line', 'yield engineering',
    ],
  },
  {
    key: 'medical',
    label: 'Medical devices',
    weight: 3,
    terms: [
      'medical device', 'iso 13485', 'fda', '510(k)', 'catheter', 'implant',
      'surgical', 'diagnostic instrument', 'biomedical', 'drug delivery',
      'gmp', 'sterilization',
    ],
  },
  {
    key: 'energy',
    label: 'Energy & climate hardware',
    weight: 3,
    // "grid" alone matched gridlock, grid patterns and part grids; "fusion"
    // alone matched Fusion 360, which is CAD software he uses daily.
    terms: [
      'battery pack', 'battery cell', 'cell manufacturing', 'gigafactory',
      'photovoltaic', 'solar module', 'wind turbine', 'power grid', 'electrical grid',
      'electrolyzer', 'hydrogen fuel', 'nuclear reactor', 'fusion energy',
      'energy storage', 'power electronics', 'grid interconnection',
    ],
  },
  {
    key: 'industrial',
    label: 'Industrial & automation',
    weight: 2,
    // The catch-all is the only field allowed to be vague, so it is the only
    // one that can win by sheer volume of weak matches — a Relativity
    // "Propulsion Manufacturing Engineer, Combustion Devices" lost to
    // `industrial` because the body said production, tooling, machining and
    // work instruction four times over. Its evidence saturates at two, so it
    // can still claim a posting nothing else wants and can no longer outvote a
    // field that actually recognised the work.
    maxEvidence: 2,
    // The lowest-weight field on purpose: it is the catch-all for "makes
    // physical things, no hotter label applies". Without the general
    // manufacturing vocabulary here, 64% of the deck fell through to `other`
    // — including plain "Manufacturing Engineer", which is his primary target
    // role. That did not just look untidy: `spreadRows` interleaves on the
    // field, so a deck that is two-thirds one value has nothing to interleave.
    terms: [
      'automation', 'plc', 'scada', 'conveyor', 'material handling',
      'production line', 'assembly line', 'cnc', 'injection molding',
      'stamping', 'weldment', 'lean manufacturing', 'six sigma',
      'manufacturing engineer', 'process engineer', 'manufacturing process',
      'production engineer', 'industrial engineer', 'tooling', 'fixture',
      'new product introduction', 'npi', 'shop floor', 'work instruction',
      'sheet metal', 'machining', 'quality engineer', 'test engineer',
    ],
  },
];

const reCache = new Map();
/** Word-boundary match, so "fab" does not fire on "fabricate". */
function termRe(term) {
  let re = reCache.get(term);
  if (re) return re;
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const left = /^\w/.test(term) ? '\\b' : '';
  const right = /\w$/.test(term) ? '\\b' : '';
  re = new RegExp(`${left}${esc}${right}`, 'i');
  reCache.set(term, re);
  return re;
}

/**
 * Classify one posting.
 *
 * @returns {{key:string, label:string, priority:boolean, matched:string[]}}
 *   key 'other' when nothing matches — an honest "not classified", not a guess.
 */
export function classifyField(job) {
  // The title is weighted by being counted twice: a posting titled "Robotics
  // Engineer" that mentions semiconductors in a company boilerplate paragraph
  // is a robotics job, and body-only frequency would call it a fab job.
  const title = String(job?.title || '');
  const hay = `${title} ${title} ${job?.team || ''} ${job?.company || ''} ${job?.description || ''}`;

  // What the ROLE is, separate from what the employer sells. NXP's "Entry Level
  // Field Applications Engineer – Emerging Markets" was badged 🤖 robotics
  // because a paragraph about NXP's end markets name-drops "next-generation
  // robotics" — the role is customer-facing semiconductor applications work.
  // A boost is a claim about the job, so it has to be earned by the title or by
  // the description meaning it more than once in passing.
  const role = `${title} ${job?.team || ''}`;

  let best = null;
  for (const f of FIELDS) {
    const matched = f.terms.filter(t => termRe(t).test(hay));
    if (!matched.length) continue;

    const isPriority = PRIORITY_FIELDS.includes(f.key);
    const inRole = f.terms.some(t => termRe(t).test(role));
    if (isPriority) {
      // One passing mention in the body, and nothing in the title, is a
      // company describing its markets — not evidence about this job.
      if (!inRole && matched.length < 2) continue;
    }

    // A priority field also forfeits its weight bonus when the title says
    // nothing. NXP's "Entry Level Field Applications Engineer" mentions both
    // robotics AND mechatronics — in the paragraph listing the markets NXP's
    // silicon serves — which cleared the two-mention bar and then beat
    // semiconductor on the tie-break. Without the bonus it has to win on
    // evidence alone, and a semiconductor applications role does.
    const weight = (isPriority && !inRole) ? f.weight - 2 : f.weight;
    // Score = how many distinct terms hit, tie-broken by the field's own
    // weight, so one passing mention loses to a field the posting is about.
    // `maxEvidence` saturates a field that is deliberately vague, so breadth
    // of weak matches cannot beat a specific recognition.
    const strength = Math.min(matched.length, f.maxEvidence ?? Infinity) + weight;
    if (!best || strength > best.strength) {
      // The LABEL and the BOOST are different claims, and conflating them is
      // what put a semiconductor applications role at the top of the deck
      // wearing a 🤖. "This posting talks about robotics" can be true while
      // "this is a robotics engineering job" is false. The label describes the
      // posting; the boost only applies when the ROLE itself is the field.
      const earned = isPriority && (inRole || matched.length >= 3);
      best = { key: f.key, label: f.label, matched: matched.slice(0, 4), strength, earned };
    }
  }

  if (!best) return { key: 'other', label: 'Other', priority: false, matched: [] };
  return {
    key: best.key,
    label: best.label,
    priority: !!best.earned,
    matched: best.matched,
  };
}

export const _internals = { FIELDS, termRe };
