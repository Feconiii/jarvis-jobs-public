// Tests for field classification — what a posting is actually about.

import { classifyField, PRIORITY_FIELDS } from './field.mjs';

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}
const job = (title, description = '', extra = {}) => ({ title, description, company: '', team: '', ...extra });

console.log('\n🧪 field: the priority fields are recognised');

check('robotics', classifyField(job('Robotics Engineer', 'motion planning and end effector design')).key, 'robotics');
check('humanoids are robotics', classifyField(job('Mechanical Engineer', 'humanoid actuator and kinematics work')).key, 'robotics');
check('cobots are robotics', classifyField(job('Automation Engineer', 'collaborative robot cells, cobot deployment, teleoperation')).key, 'robotics');
check('ai hardware', classifyField(job('Mechanical Engineer', 'cold plate and liquid cooling for a hyperscale data center')).key, 'ai-hardware');
check('space', classifyField(job('Propulsion Engineer', 'launch vehicle rocket engine, cryogenic propellant')).key, 'space');
check('robotics and AI hardware are priority',
  ['robotics', 'ai-hardware'].every(k => PRIORITY_FIELDS.includes(k)), true);
// Space is classified but NOT boosted: it is the most export-controlled sector
// there is and none of the 35 reqs in the deck stated their posture, so
// preferences.md blocks the vocabulary outright. The label stays so a space
// posting is still recognisable under "All incl. blocked".
check('space is classified but not boosted', PRIORITY_FIELDS.includes('space'), false);

console.log('\n🧪 field: the non-priority fields still classify');

check('semiconductor', classifyField(job('Process Engineer', 'wafer fab lithography and etch in a cleanroom')).key, 'semiconductor');
check('medical', classifyField(job('R&D Engineer', 'catheter design under ISO 13485 and FDA 510(k)')).key, 'medical');
check('energy', classifyField(job('Manufacturing Engineer', 'battery cell manufacturing at the gigafactory')).key, 'energy');
check('industrial', classifyField(job('Controls Engineer', 'PLC and SCADA on the assembly line conveyor')).key, 'industrial');

console.log('\n🧪 field: an honest "unknown" beats a guess');

check('nothing matched → other', classifyField(job('Mechanical Engineer', 'general design work')).key, 'other');
check('…and it is not a priority field', classifyField(job('Engineer', '')).priority, false);
check('empty input does not throw', classifyField({}).key, 'other');
check('null input does not throw', classifyField(null).key, 'other');

console.log('\n🧪 field: the title outweighs a passing mention');

// A robotics company's boilerplate often name-drops the industries it serves.
// Counting body frequency alone called those postings semiconductor jobs.
check('a robotics title survives a semiconductor mention',
  classifyField(job('Robotics Engineer, Manipulation',
    'We build robots for the semiconductor industry. Wafer handling experience a plus.')).key, 'robotics');

// And the reverse must hold — a fab job that mentions a robot arm once is a
// fab job, or the priority boost becomes a boost for everything.
check('a fab job with one robot mention stays semiconductor',
  classifyField(job('Equipment Engineer',
    'Support wafer fab etch and deposition chambers, lithography cells, cleanroom metrology, and the wafer handling robotic arm.')).key, 'semiconductor');

console.log('\n🧪 field: word boundaries');

check('"fabricate" does not read as fab',
  classifyField(job('Mechanical Engineer', 'fabricate brackets in the shop')).key, 'other');
check('"grid" in "gridlock" does not read as energy',
  classifyField(job('Engineer', 'avoid gridlock in the process')).key, 'other');

console.log('\n🧪 field: ambiguous words do not claim a posting');

// Every one of these was a real misclassification. A field filter that files a
// pharmacy job under 🚀 is worse than no filter, because it teaches you to stop
// trusting the badge — so a term only earns a place if it is unambiguous alone.
check('satellite pharmacy is not space',
  classifyField(job('Pharmacy Operations Manager', 'oversee our satellite pharmacy locations', { company: 'CVS Health' })).key, 'other');
check('automotive propulsion is not space',
  classifyField(job('Propulsion Systems Engineer', 'vehicle propulsion and powertrain', { company: 'General Motors' })).key, 'other');
check('satellite offices are not space',
  classifyField(job('Field Service Engineer', 'support satellite offices', { company: 'Applied Materials' })).key, 'other');
check('Fusion 360 is CAD, not fusion energy',
  classifyField(job('Design Engineer', 'we use Fusion 360 daily for CAD')).key, 'other');
check('a grid of fixtures is not the power grid',
  classifyField(job('Mechanical Engineer', 'lay out a grid of fixtures and avoid gridlock')).key, 'other');
check('an Amazon "launch site" is a warehouse opening, not a spaceport',
  classifyField(job('Dock Clerk, IAG1', 'Must be located at a site outside of 50 miles from the launch site.', { company: 'Amazon' })).key, 'other');

console.log('\n🧪 field: …but real ones still classify');

check('a launch company is space',
  classifyField(job('Propulsion Engineer', 'rocket engine, cryogenic propellant, launch vehicle')).key, 'space');
check('a satellite constellation is space',
  classifyField(job('Satellite Engineer', 'satellite bus design for a geostationary satellite constellation')).key, 'space');
check('low earth orbit is space',
  classifyField(job('Equipment Engineer', 'low earth orbit satellite constellation production')).key, 'space');
check('battery cell manufacturing is energy',
  classifyField(job('Manufacturing Engineer', 'battery cell manufacturing at the gigafactory')).key, 'energy');
check('fusion energy is energy',
  classifyField(job('Mechanical Engineer', 'fusion energy tokamak magnets')).key, 'energy');

console.log('\n🧪 field: industrial is the catch-all, not a swallower');

// Generic manufacturing vocabulary lives in `industrial` so plain
// "Manufacturing Engineer" — his primary target role — does not fall through
// to `other`. The risk of that is it eating everything, since a robotics or
// fab posting also mentions production and tooling. The field weights are what
// stop it, and these pin that.
check('a plain manufacturing role lands in industrial',
  classifyField(job('Manufacturing Engineer, New Grad', 'support the production line')).key, 'industrial');
check('…but a fab role stays semiconductor',
  classifyField(job('Process Engineer', 'wafer fab lithography etch cleanroom semiconductor metrology, shop floor work instructions')).key, 'semiconductor');
check('…a robotics role stays robotics',
  classifyField(job('Manufacturing Engineer', 'cobot and robotics cell integration on the assembly line with tooling')).key, 'robotics');
check('…a medical role stays medical',
  classifyField(job('Manufacturing Engineer', 'catheter production under ISO 13485 and FDA 510(k), machining and tooling')).key, 'medical');
check('…and rocket work stays space',
  classifyField(job('Propulsion Manufacturing Engineer II, Combustion Devices', 'thrust chamber machining and tooling')).key, 'space');

console.log('\n🧪 field: a boost is a claim about the ROLE, not the employer');

// NXP's "Entry Level Field Applications Engineer – Emerging Markets" was
// badged 🤖 robotics because a paragraph about NXP's end markets name-drops
// "next-generation robotics". The role is customer-facing semiconductor
// applications work. A priority field has to be earned by the title, or by the
// description meaning it more than once.
check('company end-market copy does not earn a robotics badge',
  classifyField(job('Entry Level Field Applications Engineer – Emerging Markets',
    'We help customers build next-generation robotics, smart IoT devices and industrial systems.',
    { company: 'NXP Semiconductors' })).key !== 'robotics', true);
check('one passing "data center" mention does not earn AI hardware',
  classifyField(job('Manufacturing Engineer', 'We serve the data center market.')).key !== 'ai-hardware', true);
check('…but a robotics TITLE earns it on its own',
  classifyField(job('Robotics Engineer, Manipulation', 'build things')).key, 'robotics');
check('…and real robotics content earns it without the title',
  classifyField(job('Mechanical Engineer', 'cobot cells, motion planning, end effector design and kinematics')).key, 'robotics');
check('a non-priority field still needs only one match',
  classifyField(job('Process Engineer', 'wafer fab work')).key, 'semiconductor');

console.log('\n🧪 field: what matched is reported');
const r = classifyField(job('Robotics Engineer', 'motion planning, cobot, kinematics'));
check('the matched terms come back', r.matched.length > 0, true);
check('the label is human-readable', r.label, 'Robotics & autonomy');

console.log(`\n📊 ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
