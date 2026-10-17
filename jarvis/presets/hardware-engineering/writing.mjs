/**
 * hardware-engineering preset: writing targeting. Pure data; imports nothing from jarvis/.
 * Read through jarvis/targeting.mjs, never imported directly.
 *
 * Two kinds of key live here:
 *   - FIELD wording (role emphasis, what a strong page proves, skill examples)
 *     that anyone in this field may be written with;
 *   - `examplesOwner` and `visaNotes`, which name ONE person. The writers show
 *     his worked examples, his stories and his history only when the installed
 *     person IS `examplesOwner`; anyone else on this preset gets the field
 *     wording and nothing of his.
 */
export default {
  // Whose sent answers, letters, outreach messages and history are quoted in
  // the prompts as worked examples. Nobody else's prompt ever carries them.
  examplesOwner: 'Alex Rivera',

  // The export-control warnings written to him (visa.mjs). His Applied
  // Materials summer was export-controlled, and the warning says so.
  visaNotes: {
    us_person: 'Names a "U.S. person" requirement (citizen, permanent resident, asylee or refugee). This is the hardest of the export-control wordings — the employer has to want to file for you. You have held an export-controlled role before, so it is worth asking rather than skipping, but ask early.',
    export_authorization: 'The offer is contingent on obtaining U.S. Government export authorization. That is a licence application your employer files, not a formality — but it is the same class of paperwork that cleared your Applied Materials summer. Ask what they have done before.',
  },

  // What to lead with, per role type (resume tailor, tailor-llm.mjs).
  roleEmphasis: {
    mechanical: 'mechanical design, CAD (Inventor, SolidWorks, Siemens NX), GD&T, tolerance analysis, fixtures, mechanical assembly, FEA, DFM/DFA, CNC and fabrication, test validation',
    manufacturing: 'process improvement, manufacturing readiness, DFM/DFA, CNC, time studies, root cause analysis, layout optimization, quality, inspection, cost reduction, production troubleshooting, automation',
    automation: 'AMR deployment, Universal Robots, RoboDK, machine vision, end effectors, robot integration, qualification, hardware integration, troubleshooting, Node-RED, the 6-DOF robotic arm project (ROS 2/MoveIt), the Mars rover pneumatic gripper',
    process: 'Etch, Dielectric Deposition, Metal Deposition, process data, quality data, root cause analysis, qualification, dimensional analysis, continuous improvement, troubleshooting, Excel and Python, semiconductor manufacturing',
    npi: 'DFM/DFA, fixtures, build readiness, qualification testing, CAD, manufacturing validation, troubleshooting, process documentation, CNC, rapid prototyping, cross-functional support',
    equipment: 'troubleshooting, robotics, leak testing, equipment qualification, maintenance-adjacent work, hardware integration, diagnostic documentation, cleanroom deployment, automation',
  },

  // The field, in the words the generic prompts use.
  field: 'engineering',
  resumeKind: 'engineering',
  roleTypes: 'mechanical | manufacturing | process | automation | equipment | npi | quality | other',
  // What a reader should conclude from a strong page in twenty seconds.
  impression: 'this person has designed, built, tested, debugged and deployed real hardware',
  substance: 'Technical substance beats process language every time.',
  skillExamples: 'SolidWorks, Inventor, Siemens NX, Ansys, GD&T, DFM/DFA, Tolerance Analysis, FEA, Python, CNC Machining, MIG/TIG Welding, 3D Printing, Soldering',
  // How a strong application answer in this field reads.
  answerRegister: 'Polished, professional engineering prose: what the system was and what it had to do, what the applicant owned, at most one constraint that shaped the work, and the result with its number. No component trivia and no step-by-step narration.',
  // Who an outreach message goes to, and what the work is called.
  seniorReader: 'a senior engineer',
  // The word a LinkedIn people search uses for "someone on the team" (outreach.mjs).
  searchRole: 'engineer',
};
