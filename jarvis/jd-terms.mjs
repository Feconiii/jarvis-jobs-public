#!/usr/bin/env node
// jarvis/jd-terms.mjs — what the POSTING actually names, in its own words.
//
// WHY THIS EXISTS. The tailor reports its own coverage: the model writes a list
// of the posting's requirements in its own paraphrase, then says which of them
// the resume proves. Across the 50 most recently SENT resumes (audited
// 2026-09-22) that self-report claimed **83.7%** covered — 714 of 853.
// Measured instead against the concrete nouns the job descriptions actually
// use, the same 50 resumes covered **49%** — 217 of 442.
//
// Neither number is a lie and neither is the whole truth. The model's list
// catches requirements expressed only in prose ("own a process end to end"),
// which no keyword can see. But a model that writes the exam and marks it will
// score well, and 83.7% is the number that reached him.
//
// So this is the second opinion: a fixed vocabulary of things a posting can
// NAME, matched against the JD and independently against the resume. It is
// deliberately literal. A requirement the resume demonstrates without naming
// counts as a miss here, which is why this is reported BESIDE the model's
// number and never instead of it — two measurements that disagree are more
// informative than one that cannot.
//
// Usage:
//   node jarvis/jd-terms.mjs --jd <file> --resume <file>

/**
 * Concrete things a job description names: tools, methods, processes,
 * standards, materials. Nothing vague — "ownership", "fast-paced" and
 * "collaborate" are exactly what this is meant NOT to count.
 */
export const TERMS = {
  // CAD / analysis
  SolidWorks: /solidworks/i,
  'Autodesk Inventor': /\binventor\b/i,
  AutoCAD: /autocad/i,
  'Fusion 360': /fusion\s?360/i,
  'Siemens NX': /siemens\s?nx|\bNX\b/,
  CATIA: /catia/i,
  Creo: /\bcreo\b/i,
  Ansys: /ansys/i,
  FEA: /\bFEA\b|finite element/i,
  CFD: /\bCFD\b|computational fluid/i,
  'GD&T': /GD&T|geometric dimensioning/i,
  'Tolerance analysis': /tolerance\s+(stack|analysis)/i,
  'DFM/DFA': /\bDFM\b|\bDFA\b|design for manufactur/i,
  'Engineering drawings': /engineering drawing|detail drawing|2d drawing|technical drawing/i,
  'BOM / PLM': /\bBOM\b|\bPLM\b|teamcenter|windchill|\bPDM\b/i,

  // software / controls
  Python: /\bpython\b/i,
  MATLAB: /matlab/i,
  'C/C++': /\bC\+\+\b|\bC#\b/,
  SQL: /\bSQL\b/,
  ROS: /\bROS\s?2?\b/,
  RoboDK: /robodk/i,
  'Universal Robots': /universal robot|\bUR\d|cobot/i,
  'Fanuc/ABB/KUKA': /fanuc|\bABB\b|kuka|yaskawa/i,
  PLC: /\bPLC\b|programmable logic|ladder logic|allen[- ]bradley/i,
  'SCADA/HMI': /\bSCADA\b|\bHMI\b/i,
  'Machine vision': /machine vision|computer vision|\bOpenCV\b/i,
  'Node-RED': /node-?red/i,
  Arduino: /arduino/i,
  Linux: /\blinux\b/i,
  Networking: /\bTCP\/?IP\b|\bDNS\b|\bDHCP\b|subnet|ethernet|network configuration/i,
  'AMR/AGV': /\bAMR\b|\bAGV\b|autonomous mobile/i,

  // quality / process methods
  'Six Sigma': /six sigma/i,
  DMAIC: /\bDMAIC\b/i,
  Lean: /\blean\b|\b5S\b|kaizen|value stream/i,
  SPC: /\bSPC\b|statistical process control/i,
  'Cpk / capability': /\bCpk\b|capability stud/i,
  'Gage R&R': /gage r&r|gauge r&r|\bMSA\b/i,
  DOE: /\bDOE\b|design of experiment/i,
  FMEA: /\bFMEA\b|\bPFMEA\b|\bDFMEA\b/i,
  '8D / root cause': /\b8D\b|root cause|\bCAPA\b|corrective action/i,
  'Poka-yoke': /poka.?yoke|mistake.?proof|error.?proof/i,
  'Control plans': /control plan|work instruction|traveler|standard work/i,
  'IQ/OQ/PQ': /\bIQ\b\/?\s?\bOQ\b|\bPPQ\b|process validation|validation protocol/i,
  'EVT/DVT/PVT': /\bEVT\b|\bDVT\b|\bPVT\b|\bNPI\b|new product introduction/i,
  Metrology: /metrolog|\bCMM\b|coordinate measuring/i,
  'Test / qualification': /qualification|acceptance test|\bFAT\b|\bSAT\b|commissioning/i,
  Yield: /\byield\b|throughput|\bOEE\b|scrap rate/i,
  'MES / ERP': /\bMES\b|\bERP\b|\bSAP\b/i,

  // making things
  'CNC machining': /\bCNC\b/i,
  'Manual machining': /\bmill\b|\blathe\b|manual machin/i,
  Welding: /\bweld/i,
  'Sheet metal': /sheet metal|press brake|laser cut/i,
  '3D printing': /3d print|additive manufactur/i,
  'Fixture / tooling': /fixture|tooling|\bjig\b/i,
  Soldering: /solder/i,
  'Mechanical assembly': /mechanical assembly|assembly line/i,

  // domains
  Cleanroom: /clean\s?room/i,
  Vacuum: /vacuum|outgassing|\bUHV\b/i,
  Semiconductor: /semiconductor|wafer|\bfab\b|foundry/i,
  Etch: /\betch\b/i,
  Deposition: /deposition|\bCVD\b|\bPVD\b|thin film/i,
  Lithography: /lithograph|photomask/i,
  CMP: /\bCMP\b/,
  Thermal: /thermal|heat transfer|heat sink/i,
  Fluids: /pneumatic|hydraulic|fluid power/i,
  'Electrical / wiring': /wiring|harness|\bDIN rail\b|electrical schematic/i,
  'Motors / actuators': /actuator|servo|stepper motor/i,
  Sensors: /\bLiDAR\b|\bIMU\b|sensor integration|load cell/i,
  'Ingress / sealing': /\bIP\d\d\b|ingress protection|gasket|\bO-ring\b/i,
  'Medical / ISO': /ISO 13485|\bFDA\b|\bGMP\b|\bDHF\b|design control/i,
  'Supplier / vendor': /supplier|vendor|contract manufactur/i,
  'Data analysis': /data analysis|data[- ]driven|analytics|dashboards?/i,
  Safety: /\bOSHA\b|\bANSI\b|machine safety|lockout/i,
};

/** Which of the vocabulary a piece of text names. */
export function termsIn(text) {
  const t = String(text || '');
  const out = new Set();
  for (const [name, re] of Object.entries(TERMS)) if (re.test(t)) out.add(name);
  return out;
}

/**
 * What this posting NAMES, and how much of it this resume names back.
 *
 * `covered` / `missing` are the posting's own words. `unmatched` is the other
 * direction and the one his 2026-09-22 instruction is about: what the page
 * carries that this employer never asked for.
 */
export function coverage(jdText, resumeText) {
  const jd = termsIn(jdText);
  const cv = termsIn(resumeText);
  const covered = [...jd].filter((t) => cv.has(t));
  const missing = [...jd].filter((t) => !cv.has(t));
  const unmatched = [...cv].filter((t) => !jd.has(t));
  return {
    named: jd.size,
    covered,
    missing,
    unmatched,
    // null rather than 0 when the posting names nothing concrete — a marketing
    // page is not a resume that covered none of it.
    pct: jd.size ? Math.round((covered.length / jd.size) * 100) : null,
  };
}

/** One line for the tailoring report. Empty when the JD names nothing. */
export function coverageLine(jdText, resumeText) {
  const c = coverage(jdText, resumeText);
  if (!c.named) return '';
  return `  names ${c.covered.length}/${c.named} of the terms this posting uses (${c.pct}%)`
    + `${c.missing.length ? ` — not named: ${c.missing.slice(0, 10).join(', ')}${c.missing.length > 10 ? `, +${c.missing.length - 10}` : ''}` : ''}`
    + `\n  and carries ${c.unmatched.length} term(s) the posting never asks for`;
}

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const arg = (f) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : null; };
  const { readFileSync } = await import('fs');
  const jd = arg('--jd'); const cv = arg('--resume');
  if (!jd || !cv) { console.log('usage: node jarvis/jd-terms.mjs --jd <file> --resume <file>'); process.exit(1); }
  const c = coverage(readFileSync(jd, 'utf-8'), readFileSync(cv, 'utf-8'));
  console.log(`\n  posting names ${c.named} concrete terms; the resume names ${c.covered.length} of them (${c.pct}%)\n`);
  console.log(`  covered:   ${c.covered.join(', ') || '(none)'}\n`);
  console.log(`  NOT named: ${c.missing.join(', ') || '(none)'}\n`);
  console.log(`  the resume also carries ${c.unmatched.length} the posting never asks for:\n    ${c.unmatched.join(', ')}\n`);
}
