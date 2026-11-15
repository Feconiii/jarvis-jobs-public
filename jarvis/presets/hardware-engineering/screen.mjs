/**
 * hardware-engineering preset: screen targeting. Pure data; imports nothing from jarvis/.
 * Read through jarvis/targeting.mjs, never imported directly.
 *
 * Every constant here was moved VERBATIM out of the module named above it, so
 * the original user's screening is unchanged; the reasoning behind each one is
 * still in the comments of that module.
 */

// ── triage.mjs ──────────────────────────────────────────────────────

/** Soft relevance words (substring match, title counts 8, body 3). */
const relevanceSignals = [
  'mechanical', 'manufacturing', 'process engineer', 'industrial engineer', 'automation',
  'controls', 'semiconductor', 'equipment engineer', 'mechatronics', 'robotics',
  'design engineer', 'product engineer', 'npi', 'new product introduction', 'reliability',
  'test engineer', 'validation', 'quality engineer', 'supplier quality', 'applications engineer',
  'field service', 'field engineer', 'customer engineer', 'facilities', 'production',
  'operations', 'project engineer', 'sustaining', 'process integration', 'metrology',
  'cnc', 'additive', 'tooling', 'fixture', 'gd&t', 'solidworks', 'cad', 'fea',
  'thermal', 'fluid', 'vacuum', 'motion', 'actuator', 'yield', 'failure analysis',
  'assembly', 'fabrication', 'machining', 'wafer', 'fab ', 'cleanroom', 'hardware',
];

// ── curate.mjs: the reader's brief ──────────────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
/** The month after graduation, "June 2027" for a May 2027 graduate. */
const startLabel = (g) => (g.month >= 12 ? `${MONTHS[0]} ${g.year + 1}` : `${MONTHS[g.month]} ${g.year}`);
const STATUS = {
  f1: 'F-1 student, will need OPT then H-1B sponsorship.',
  visa: 'On a work visa, will need H-1B sponsorship.',
  citizen: 'U.S. citizen, no sponsorship needed.',
  permanent_resident: 'U.S. permanent resident, no sponsorship needed.',
  no_sponsorship_needed: 'Authorized to work in the U.S., no sponsorship needed.',
};

/** One line on the employer for bar 3: its class and its H-1B record, when the curator knows them. */
function employerLine(job) {
  const kind = {
    // A star has passed the startup tests by being on the list (F-948:
    // Standard Bots, Normal Computing, Matic Robots, Heron Power and Medra were
    // dropped for "survivability" because their postings named no funding).
    star: 'on his frontier list — he wants it. It has ALREADY PASSED his startup tests (moat, flashy product, survivability, capital): never drop it for funding, headcount or survivability the posting does not mention.',
    name: 'a big name he counts (established chips, big medtech, carmakers, big machine makers, big tech).',
    role: 'an industrial conglomerate — the role decides.',
    backup: 'a contract manufacturer — "only as backup": KEEP only a clearly strong fit, otherwise MAYBE at most.',
    // F-948, his decision 2026-11-05: a VC hiring list is not funding; only a known round is.
    vc: 'a startup he knows to be FUNDED (a known funding round): it passes survivability and capital without the posting naming money or headcount. Judge moat, flashy product and sponsorship from the posting.',
    other: 'not a name he knows — judge it as a startup by the tests below, or as a traditional company.',
  }[job.employerClass] || 'judged by the rules below.';
  const h1b = Number.isFinite(job.h1b) ? ` Certified H-1B engineering petitions on record: ${job.h1b}.` : '';
  const robotics = ROBOTICS_EMPLOYERS.test(String(job.company || '').trim()) ? ' A ROBOTICS COMPANY (the 1-2 years stretch rule applies).' : '';
  return `${kind}${h1b}${robotics}`;
}

/**
 * ROBOTICS COMPANIES for the stretch rule (his answer 2026-11-06, "5. ye": a
 * role asking 1-2 years is read as a stretch fit at ROBOTICS companies only).
 * His robotics-first company list of 2026-11-06 plus the robotics names on his
 * frontier list. Tesla stays capped and is not here.
 */
// Whole names, never a prefix that answers for another company (review
// 2026-11-06: "Figure Lending", "Agility Logistics", "Sunday Natural",
// "Rebuild Manufacturing" are not his robotics companies).
const ROBOTICS_EMPLOYERS = /^(?:figure(?:\s+ai)?|apptronik|boston dynamics|agility robotics|1x(?:\s+technologies)?|sunday robotics|sunday|skild(?:\s+ai)?|collaborative robotics|cobot|persona ai|physical intelligence|neuralink|google deepmind|deepmind|symbotic|dexterity|mujin|mytra|pickle robot(?:\s+company)?|intuitive surgical|intuitive|stryker|johnson\s*(?:&|and)\s*johnson|medra|formlabs|path robotics|standard bots|divergent(?:\s+technologies)?|universal robots|teradyne robotics|mobile industrial robots|re:build manufacturing|re:build|skydio|zipline|bedrock robotics|field ai|gecko robotics|the bot company|dyna robotics|genesis ai|foundation robotics|weave robotics|matic robots)(?:,?\s+(?:inc|llc|corp(?:oration)?|co|ltd|gmbh|ag|technologies|holdings)\.?)?$/i;

/**
 * The whole brief the curator's reader gets for one posting. Moved from
 * curate.mjs promptFor(); for the default person it returns the same string.
 */
function curatePrompt(person, job, description, cvShort, prior = []) {
  const status = `${STATUS[person.workAuth] || STATUS.f1} Graduates ${person.gradLabel}, can start ${startLabel(person.gradDate)}.`;
  const auth = person.usPerson ? '' : `WORK AUTHORIZATION — ${person.workAuth === 'f1' ? 'he is on F-1' : 'he is not a U.S. person'} and these are his own hides, every one:
   - DROP any mention of ITAR / International Traffic in Arms Regulations ("fuckin itar").
   - DROP a "U.S. person" requirement in any wording: U.S. citizen, lawful permanent resident / green card holder, asylee, refugee or "protected individual under 8 U.S.C. 1324b(a)(3)" — EVEN WITH "or eligible to obtain the required authorizations" ("it says us person why tf you present this to me").
   - DROP green card or permanent residency required ("if they want green card 100% im cooked"), and any no-sponsorship statement: "will not sponsor", "No Visa Sponsorship", "must be authorized to work without sponsorship now or in the future".
   - NOT a drop: the routine semiconductor line "…may have to go through an export licensing review" (Analog Devices, Onto, Applied Materials style), or "may require access to information subject to U.S. export control laws. Applicants must be authorized to access such information or eligible for government authorization" (Samsung Austin Semiconductor, 2026-10-03) — a licence he can be granted is not a U.S.-person requirement. Quote it in the note.
`;
  return `You are curating job postings for ${person.fullName}. Read the ENTIRE description below and decide.

HIS FACTS (the only facts you may use about him):
${cvShort}
Status: ${status}

BOTH BARS MUST HOLD FOR KEEP:
1. Qualified as written.
   - Degree: Bachelor's in Mechanical, or "Engineering" / "a related technical field" generally, passes. If it lists only other disciplines (Electrical, Chemical, Computer, CS, Materials, Physics) with no mechanical and no general engineering: DROP. Master's/PhD required: DROP.
   - Years: "0", "0-2", new grad, entry level, "internships/co-ops count" pass. Preferred years up to 2 are fine.
     A ROLE MADE FOR GRADUATING STUDENTS NEVER FAILS ON YEARS (his rule, 2026-11-06): when the title or the posting names a new-grad, university-hire, early-career or graduate program, or a graduating class ("May 2027 Graduates", "Class of 2027"), a years line in it that starts at 1 or 2 ("1-3", "1+", "2+") means internships and co-ops, which he has. Never DROP such a role for that line. Judge it on everything else, and still DROP it if its graduation window excludes ${person.gradLabel}. A new-grad title that asks for 3+ years is still mislabelled and still a DROP (the rule below).
     A RANGE THAT STARTS AT ZERO PASSES, whatever its top: "0-3", "0–5", "0+" all include no experience (2026-10-16: Queue's Mechanical Engineer, "0–3 years of hands-on mechanical or mechatronic engineering experience", was dropped as if it said 1-3 — he found it in the library and applied). The upper number is the band they hire across, not a bar.
     AT A ROBOTICS COMPANY (the employer line says so), A REQUIRED 1 OR 2 YEARS IS A STRETCH, NOT A DROP (his rule, 2026-11-06: "ye"). A required years line that starts at 1 or 2 ("1-2", "1-3", "2+", "2-4") is answered MAYBE when the role passes everything else. The note STARTS with that years line quoted word for word. 3+ is still a DROP. Field service, technical support and quality roles stay DROPs as before.
     ONE YEAR IS A MAYBE, NOT A DROP (his decision, 2026-10-04: about half of every posting read was turned down on years, and he has two engineering internships). A REQUIRED "1 year" or "1+": MAYBE. A REQUIRED "1-2": MAYBE only when the posting itself says internships, co-ops or academic projects count toward it; otherwise DROP. For either MAYBE the note STARTS with the years line quoted word for word. A REQUIRED "1-3", "2+" or more: DROP. A years line under "Minimum qualifications", "Required" or "What we're looking for" IS required unless that line itself says preferred (F-622). THREE OR MORE YEARS PREFERRED COUNTS AS REQUIRED: DROP (his words: "if it says 3 yoe preferred 100% it means mandatory"). A "new grad" or "entry level" title that asks for 3+ years anywhere: DROP ("how the actual fuck you gonna say 3-5 yrs of experience and label it new grad").
   - A pay grade of E2 or higher anywhere in the posting (Applied Materials style "E2", "E3"), unless it is a graduate or rotation program: DROP ("stop showing me e2 e3 level roles for amat").
   - PLC programming named as required: DROP (he has none).
   - A graduation window excluding ${person.gradLabel}: DROP. Internships and co-ops: DROP.
2. Relevant: semiconductor/semicap, robotics and automation, medical devices, EV/battery/energy hardware, commercial aerospace (eVTOL, commercial aircraft, delivery drones — never defense or spacecraft), high-tech manufacturing, VEHICLES AND HEAVY MACHINERY (automotive including non-EV, trucks, agricultural, construction and mining equipment), or ENERGY (power generation, utilities, oil & gas equipment and plants) — he widened it on 2026-10-08 to be "less picky on how cool it is", and narrowed WHO on 2026-10-25 (bar 3) — AND the work is mechanical, manufacturing, equipment, process or automation engineering. DROP electrical/circuit/PCB, firmware, software, IT, pure chemistry, HVAC/MEP/building, civil/construction, grid/transmission/protection electrical work, facilities/compliance desks, sales. EXCEPTION: AI data-center hardware is his ("all of it", 2026-10-25) — liquid cooling, rack, thermal and data-center mechanical work at an AI or cloud company is read as usual.
   TEST ROLES: DROP ("avoid test roles", 2026-10-25) — test, validation, verification and reliability engineer roles, lab or production. He wants design, process, equipment or manufacturing ownership.
   THERMAL ROLES: DROP ("for thermal jobs I think it's a waste of time, not my interest plus no expertise", 2026-11-05) — a role whose core is thermal systems or thermal engineering, HVAC, heat transfer, or thermal management or analysis, whatever its title says. A role that only mentions thermal in passing (one duty among many, a nice-to-have) is read as usual. The AI data-center exception above still stands.
   CONSUMER PRODUCTS only from a high-prestige employer that is growing (Apple, Dyson, WHOOP, Eight Sleep tier; not Garmin, Peloton, GoPro, iRobot, Sonos). A narrow or novelty product line is a DROP even when the role itself is fine (razors, telescopes, gym equipment, hair dryers, barcode printers, cable sleeving — 2026-10-08: "why would i want to work there over amat").
Also DROP: night/graveyard/2nd/3rd/swing shift, compressed 12-hour or weekend-only schedules; security clearance; defense or weapons; spacecraft, satellites, launch vehicles.
   An AEROSPACE SUPPLIER that names military, defense or space programs among its markets is a DROP, not a MAYBE, when this site's product could be defense-bound (Ducommun, 2026-10-03: "check for ITAR at the application step" is a catch he never takes). A diversified company whose posting is for a clearly civilian business unit is read as usual.
   THE TEST IS THIS SITE'S OWN PRODUCT, never a parent company's list of markets (2026-10-16): Dodge Industrial's "Manufacturing Engineer - Entry level" builds industrial power-transmission parts (bearings, gearboxes, couplings) and was dropped because its parent RBC Bearings names defense among its customers. An industrial plant is not an aerospace supplier because its owner also sells to defense. Drop only when the posting itself, or the site's product, is aerospace or defense.
${auth}3. HIS KIND OF EMPLOYER (his taste quiz, 2026-10-25: "a lot of them just dont sponsor but they dont say it, especially legacy dinosaur companies or traditional industries, plus it looks lame … in reality i want flashiness and prestige or good career"). This employer is ${employerLine(job)}
   - A small or mid-size TRADITIONAL company is a DROP however good the role: lighting, HVAC, building products, construction, small auto-parts suppliers, commodity industrial, plastics, tires, narrow product lines. "Why would I want to work for a lighting or HVAC or construction company or some tier 2 supplier for cars."
   - A STARTUP that is NOT on his frontier list must pass all five of his tests, from the posting itself: a product moat and future prospects; a flashy product; survivability — at least $20M raised or 40+ people; real capital behind it; and nothing saying it will not sponsor. Missing any one: DROP, and name the one in "why". One he knows to be funded (a known funding round) has already passed survivability and capital; being on a VC hiring list is not funding.
   - An INDUSTRIAL CONGLOMERATE (Honeywell, Eaton, Emerson, 3M, Parker, ITW) is a dinosaur to him: KEEP only when the product or the work itself is exciting and moving fast — new product development on something impressive. Sustaining a mature line: DROP.
   - The name beats the title: a manufacturing, process or equipment role at a star is worth more to him than a design role somewhere he would not brag about. A small town is fine when the name is big. The pay floor holds everywhere.
KINDS OF WORK HE HAS TURNED DOWN — DROP: any FIELD role ("ban all field jobs, they are not a good career path") EXCEPT a robotics one — field robotics, robotics field service, forward-deployed robotics engineering are fine ("the only field roles i accept are robotics"); non-robotics field service, service or maintenance engineering, quality engineer, industrial engineer, sustaining engineering, flight test, a rotation program longer than two years ("4 yr rotation is crazy").
ALSO TURNED DOWN — DROP (read off his inbox, 2026-10-16: "some ass companies in picks … u should know me well enough to see what i would skip"):
   - NUCLEAR PLANTS, NUCLEAR UTILITIES AND FLEET SUPPORT: Westinghouse, Constellation, Zachry and their like ("i dont like nuclear", 2026-09-02). The energy widening of 2026-10-08 does not reach them. A new-reactor STARTUP building its own hardware (Radiant) is read as usual — he tried to apply there.
   - Driving or flight VALIDATION, where the job is running the vehicle and logging features (ADAS driving validation; "all i do is flying or test the flying i dont see the engineering").
   - Refinery or plant ROTATING EQUIPMENT and reliability engineering — that is maintenance.
   - Material Review Board / material review engineering — that is quality.
   READ OFF HIS OWN SKIP NOTES, 2026-10-23 TO 11-02 (each one a posting a reader had put in front of him):
   - A DEGREE LADDER IS JUDGED AT THE BACHELOR'S RUNG. "Doctorate and 0 years; Master's and 2 years; Bachelor's and 5 years" means HE needs 5 years: DROP. The zero belongs to a degree he does not hold (KLA Manufacturing Systems Engineer: "literally says bachelor with 5 years does reader not have basic comprehension???").
   - SAFETY ROLES: product safety, EHS, safety compliance engineer — DROP ("fuck safety jobs", Applied Materials' NCG Product Safety Engineer).
   - OPERATIONS ENGINEER roles that run a site's day-to-day (Amazon "Operations Engineer, GES", "AMZL Operations Integration Engineering"): DROP as the wrong kind of work. Not a drop: process, equipment or automation engineering that designs or improves the line.
   - A SPECIALIST ROLE WHOSE CORE SKILL HIS FACTS NEVER SHOW — power-generation fluids, welding procedure (PWS) engineering, body-in-white design — DROP even at a name he loves ("i love the company but no chance i get this i have 0 relevant experience", xAI Fluids Engineer).
   - THE ONE-YEAR MAYBE IS FOR GENERAL ENGINEERING EXPERIENCE. A required year IN A NAMED FIELD he has none of (AISIN: one year in that manufacturing field, "min 1 year in field i dont have + small company = guaranteed rejection") is a DROP.
   - SYSTEMS ENGINEERING THAT IS REQUIREMENTS PAPERWORK — writing requirement documents, keeping the register, tracing to tests (Pickle Robot's Junior Systems Engineer) — is administration: DROP.
   - "More software than hardware" (Nimble Robotics' field role): when most listed duties are software, scripting or IT, it is software, whatever the title says.
   - Packaging engineering (package design, sealing, validation), at any company.
   - Facilities and utility operations: bulk gas, chemical distribution, plant utilities, facilities systems.
   - Applications engineering that is order configuration, CPQ, quoting or sales support; a "Product Engineer" that is product management.
   - Food and beverage plants; building, plumbing, water-fitting, elevator, lighting and electric-utility-tool products (Acuity, Watts, Romac, Vantage, Hubbell's lineman tools).
   - An "Engineer II" / "Level II" title with a required year of experience — "stop showing me e2 e3 level roles".
   - A small lab or nonprofit that will only "consider sponsorship case by case".
   - ADMINISTRATION WORK, whatever the title says ("avoid administration work", 2026-10-16): document control, change/configuration management desks, ECO/ECN processing, BOM or item-master upkeep, ERP/SAP/PLM/MES administration, CAD or PDM administration, compliance and audit paperwork, records, scheduling, planning, procurement and purchasing coordination, data entry and reporting. Judge by the duties: when most of the day is maintaining systems, documents or records rather than designing, building, testing or improving hardware and processes, DROP. ONLY THEN — his words: "i dont mean avoid them completely i mean roles that all they do is that kind of bs". Some documentation, ECOs, BOMs or SAP alongside real engineering is normal and is NOT a reason to drop.
MAYBE (not KEEP): heavy travel, applications engineer, or a real doubt you can name.
A POSTING THAT STATES NO REQUIREMENTS — no degree, no years, no qualifications — cannot be checked against bar 1: DROP, never MAYBE (2026-10-04: six CNH cards filed as "the description has no requirements, check before applying"; his rule is that nothing goes in his inbox that the description does not prove he qualifies for).

ALREADY AT THIS COMPANY (applied, in his list, rejected or hidden): ${prior.length ? prior.join('; ') : 'nothing'}
The same or nearly the same title already on that list: DROP, and say which. A title that differs only in the CITY or SITE it names is a separate opening at another site, not a duplicate: read it as usual (Applied Materials' Kalispell, MT new-grad ME role was dropped against the Santa Clara one he applied to, 2026-10-03). Each entry names its site: one marked OTHER SITE is a separate opening he would apply to, never a duplicate, and neither is an entry with the same title that was [rejected] at another site. Drop as a duplicate only the same title at the SAME SITE, the same requisition, or the same title he [hidden].

POSTING: ${job.company} — ${job.title} — ${job.location || ''}
---
${String(description || '').slice(0, 14000)}
---

REACH (a label only; it changes no verdict, 2026-11-04, F-934): for a KEEP or MAYBE, say whether it is a reach and of which kind. "degree": his degree is not among the degrees the posting lists. "field": the core work is another discipline (electronics, sensors, optics, chemistry or materials, software). "level": the level or the pay asks for more experience than a new graduate has. Otherwise null.

Answer with ONE line of JSON and nothing else:
{"verdict":"KEEP"|"MAYBE"|"DROP","why":"<the deciding fact, one line>","note":"<KEEP/MAYBE only: two plain sentences for his card. First: the concrete overlap with his experience above. Second: why he can win it, quoting the posting's years or new-grad words. For MAYBE start with the catch. No hype.>","reach":null|"degree"|"field"|"level"}`;
}

export default {
  // ── triage.mjs ────────────────────────────────────────────────────
  /** Title words that make a posting senior / lead / management. */
  seniorTitle: /\b(senior|sr\.?|staff|principal|lead|distinguished|manager|supervisor|superintendent|director|head\s+of|vp|vice\s+president|chief|architect)\b/i,
  /** Title or body words that make a posting entry level. */
  entryTitle: /\b(new\s+grad(uate)?|entry[-\s]?level|early\s+career|university\s+(hire|grad)|campus|associate|engineer\s+(i|1)\b|graduate\s+(engineer|program)|rotational|rotation\s+program|development\s+program|apprentice)\b/i,
  /** New-grad wording (title, or body when not negated). */
  newGradTitle: /\b(new\s+col?lege\s+grad(uate)?s?|new\s+grad(uate)?s?|recent\s+grad(uate)?s?|university\s+(grad(uate)?|hire|recruiting)|campus\s+hire|graduate\s+(program|scheme|engineer)|early\s+career|rotational\s+(?:\w+\s+)?program|leadership\s+development\s+program|class\s+of\s+20\d\d)\b/i,
  relevanceSignals,
  /** A title naming his kind of degree subject: +10 relevance. */
  majorSignals: /\b(mechanical|manufacturing|industrial|electromechanical|mechatronic|aerospace|materials|engineering)\b/i,
  /** A body that opens the posting to his whole field: +10 relevance. */
  relevanceAcceptsAll: /accepts?\s+(all\s+)?engineering/i,
  /** Technician / operator / trades titles: a different track. */
  handsOnTitle: /\b(technician|tech\b|operator|machinist|assembler|welder|fabricator|inspector|material\s+handler|warehouse|custodian|janitor|driver|production\s+(associate|worker)|line\s+(lead|worker)|installer|mechanic|apprentice(?!\s+engineer))\b/i,
  /** A title word that always makes it professional, whatever else it says. */
  professionalTitle: /\bengineer\b/i,

  // ── degree.mjs ────────────────────────────────────────────────────
  /** Disciplines that read as "he qualifies". */
  hisDisciplines: [
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
  ],
  /** Not his, and "or related field" cannot reach him from here. */
  farDisciplines: [
    'electrical', 'electrical engineering', 'ee',
    'electronics', 'electronic engineering', 'microelectronics',
    'computer science', 'cs', 'computer engineering', 'ce',
    'software engineering', 'information technology', 'information systems',
    'nursing', 'pharmacy', 'accounting', 'finance', 'marketing',
    'human resources', 'business administration', 'economics',
    'law', 'journalism', 'graphic design',
  ],
  /** Not his, but close enough that "or related field" plausibly includes him. */
  adjacentDisciplines: [
    'chemical', 'chemical engineering', 'cheme',
    'civil', 'civil engineering', 'structural engineering',
    'biomedical', 'bioengineering', 'biology', 'biochemistry', 'chemistry',
    'petroleum', 'mining', 'nuclear engineering', 'agricultural',
    'environmental engineering', 'geology', 'engineering science',
  ],
  /**
   * Text that looks like a degree token and is not: "MS Office", "MS Excel",
   * "MS-Office-Kenntnisse", "MS SQL Server", a "CRM MS Dynamics" title. Each is
   * Microsoft software, never a Master of Science (F-755: such rows were blocked
   * as Master's-only).
   */
  notADegree: /\bMS[\s-]+(?:Office|Excel|Word|PowerPoint|Access|Project|Outlook|Teams|Dynamics|Visio|SQL|365|SharePoint|Windows|Exchange|Azure|Power\s?(?:BI|Apps|Automate|Platform))\b/i,

  // ── eligibility.mjs ───────────────────────────────────────────────
  /** A degree line naming his field, or engineering generally.
   *  F-771: "Mechatronics" (plural) failed the closing \b, so "Bachelor’s degree
   *  in Electrical Engineering, Computer Engineering, Mechatronics, or …" read as
   *  a list without him; and "BS in EE/CS/ME/Controls" names him as ME (capitals
   *  only — "me" is a word), as do BSME and MSME. */
  hisField: /\b(mechanical|mechatronic\w*|manufactur\w*|industrial engineer\w*|any engineer\w*|all engineering|engineering discipline|\bstem\b|engineering (technology|science)|(?-i:ME)|b\.?s\.?m\.?e|m\.?s\.?m\.?e)\b/i,
  /** Somebody else's degree; only used to detect a list that excludes him.
   *  ("BSEE" and "MSEE" are one word, and named nothing on their own. "BSCS" is
   *  left out: "BSCs" is also building-service contractors.) */
  otherField: /\b(electrical|electronic|computer (science|engineering)|software|comp sci|cs\b|data science|information (systems|technology)|chemical engineer|chemistry|biology|biomedical|civil engineer|finance|accounting|business administration|marketing|human resources|supply chain|nursing|physics|bs\s?ee|ms\s?ee|bsece)\b/i,
  /** His field named generically ("Engineering" with no other discipline in front). */
  genericField: /(?<!\b(?:electrical|electronic|computer|software|chemical|civil|biomedical|biological|nuclear|petroleum|environmental|agricultural|architectural|marine|mining|data|financial|sales)\s{1,3})\bengineering\b/i,
  /** Titles that are unambiguously another discipline's work. */
  otherTitle: /\b(asic|rtl|verilog|vhdl|firmware|design for test|\bdft\b|physical design|analog|circuit design|\bsoc\b|tapeout|mask operations|wafer test|software (dev(elopment)? )?engineer|\bsde\b|full[- ]stack|web developer|web front[- ]end|data (scientist|analyst|engineer)|business (analyst|intelligence)|machine learning (engineer|scientist)|cybersecurity|security analyst|network engineer|cloud (hardware|infrastructure|engineer)|devops|\bsre\b|marketing|sales|recruit|human resources|finance|accountant|legal|paralegal|nurse|\bbuyer\b|procurement|account manager|data science|\banalyst,|,\s*analyst|manufacturing it\b|\bit\s+analyst)/i,
  /** Other-discipline words that only count when the title does not also name his work.
   *  F-771: "supply chain" and "logistics" moved here from otherTitle — Apptronik's
   *  "Manufacturing Engineer (Supply Chain) - Electromechanical" and Garmin's
   *  "Process Engineer 2 - Global Service/Reverse Logistics" are his titles. */
  softOtherTitle: /\b(verification|machine learning|product support|customer (success|support)|workflow automation|supply chain|logistics)\b/i,
  /** A title that names his work. */
  hisTitle: /\b(mechanical|mechatronic\w*|manufactur\w+|industrial engineer|process engineer|equipment engineer|fab automation|factory automation|robotics and automation|tooling|machining|fixture|thermal|hvac|quality engineer|reliability engineer|field service)\b/i,
  /** The reason a subject-excluded posting carries. */
  subjectExcludedReason: 'names degree subjects and mechanical is not one',

  // ── fit.mjs ───────────────────────────────────────────────────────
  /** Canonical skills and their aliases (has = in cv.md, wanted = in the posting). */
  skills: [
    // CAD / design
    { id: 'solidworks', w: 3, a: ['solidworks', 'solid works'] },
    { id: 'inventor', w: 2, a: ['autodesk inventor', 'inventor'] },
    { id: 'autocad', w: 2, a: ['autocad'] },
    { id: 'fusion360', w: 2, a: ['fusion 360', 'fusion360'] },
    { id: 'nx', w: 2, a: ['siemens nx', 'unigraphics', ' nx '] },
    { id: 'catia', w: 1, a: ['catia'] },
    { id: 'creo', w: 1, a: ['creo', 'pro/engineer'] },
    { id: 'cad-generic', w: 2, a: ['cad', '3d modeling', '3d modelling', 'computer-aided design'] },
    { id: 'gdt', w: 3, a: ['gd&t', 'gdt', 'geometric dimensioning', 'tolerance analysis', 'tolerance stack'] },
    { id: 'dfm', w: 3, a: ['dfm', 'dfa', 'design for manufactur', 'design for assembly'] },
    { id: 'drafting', w: 1, a: ['technical drawing', 'engineering drawing', 'drafting', 'blueprint'] },

    // analysis
    { id: 'fea', w: 3, a: ['fea', 'finite element', 'ansys', 'structural analysis'] },
    { id: 'thermal', w: 2, a: ['thermal analysis', 'heat transfer', 'thermal management'] },
    { id: 'fluids', w: 2, a: ['fluid mechanics', 'cfd', 'computational fluid', 'hydraulic', 'pneumatic'] },
    { id: 'statics', w: 1, a: ['mechanics of materials', 'stress analysis', 'statics'] },

    // manufacturing / hands-on
    { id: 'cnc', w: 3, a: ['cnc', 'haas', 'machining', 'milling', 'lathe', 'turning center'] },
    { id: 'cam', w: 2, a: ['cam', 'toolpath', 'g-code', 'gcode', 'mastercam'] },
    { id: 'welding', w: 2, a: ['welding', 'mig', 'tig', 'brazing'] },
    { id: 'fixture', w: 3, a: ['fixture', 'jig', 'tooling design', 'workholding'] },
    { id: 'additive', w: 2, a: ['additive manufactur', '3d printing', 'rapid prototyp', 'sla', 'sls'] },
    { id: 'sheetmetal', w: 1, a: ['sheet metal', 'stamping', 'forming', 'roll form'] },
    { id: 'molding', w: 1, a: ['injection molding', 'casting', 'extrusion'] },
    { id: 'assembly', w: 2, a: ['mechanical assembly', 'assembly process', 'build process'] },
    { id: 'prototyping', w: 2, a: ['prototyp', 'bench testing', 'breadboard'] },

    // automation / robotics
    { id: 'robotics', w: 4, a: ['robot', 'robotic', 'robotics'] },
    { id: 'cobot', w: 4, a: ['cobot', 'collaborative robot', 'universal robots', ' ur5', ' ur10'] },
    { id: 'robodk', w: 3, a: ['robodk', 'robot simulation', 'offline programming'] },
    { id: 'amr', w: 4, a: ['amr', 'agv', 'autonomous mobile robot', 'automated guided vehicle', 'mobile robot'] },
    { id: 'plc', w: 3, a: ['plc', 'ladder logic', 'allen bradley', 'siemens s7', 'scada', 'hmi'] },
    { id: 'motion', w: 2, a: ['motion control', 'servo', 'actuator', 'stepper', 'linear stage'] },
    { id: 'kinematics', w: 2, a: ['kinematic', 'inverse kinematics', 'path planning', 'trajectory'] },
    { id: 'ros', w: 2, a: ['ros', 'ros2', 'robot operating system'] },
    { id: 'automation', w: 3, a: ['automation', 'automated system', 'industrial automation'] },

    // vision / data / IoT
    { id: 'vision', w: 4, a: ['machine vision', 'computer vision', 'vision system', 'cognex', 'keyence', 'image classification', 'object detection'] },
    { id: 'iot', w: 3, a: ['iot', 'iiot', 'industrial internet', 'tulip', 'edge device', 'data logging'] },
    { id: 'sensors', w: 2, a: ['sensor', 'instrumentation', 'data acquisition', 'daq'] },

    // quality / process
    { id: 'sixsigma', w: 3, a: ['six sigma', 'lean', 'kaizen', '5s', 'continuous improvement'] },
    { id: 'spc', w: 2, a: ['spc', 'statistical process control', 'control chart', 'capability study'] },
    { id: 'rootcause', w: 3, a: ['root cause', 'rca', '8d', 'fmea', 'failure analysis', 'corrective action'] },
    { id: 'metrology', w: 3, a: ['metrology', 'cmm', 'coordinate measuring', 'caliper', 'dimensional inspection', 'gauge'] },
    { id: 'qms', w: 1, a: ['iso 9001', 'as9100', 'ppap', 'quality management system'] },
    { id: 'timestudy', w: 2, a: ['time study', 'cycle time', 'takt', 'throughput analysis', 'line balanc'] },
    { id: 'layout', w: 2, a: ['plant layout', 'facility layout', 'material flow', 'value stream'] },
    { id: 'npi', w: 3, a: ['npi', 'new product introduction', 'design transfer', 'pilot production'] },
    { id: 'validation', w: 3, a: ['validation', 'verification', 'iq oq pq', 'qualification', 'test protocol'] },

    // software
    { id: 'python', w: 3, a: ['python'] },
    { id: 'matlab', w: 1, a: ['matlab', 'simulink'] },
    { id: 'vba', w: 2, a: ['vba', 'excel macro', 'visual basic'] },
    { id: 'nodered', w: 1, a: ['node-red', 'node red'] },
    { id: 'sql', w: 1, a: ['sql', 'database quer'] },
    { id: 'labview', w: 1, a: ['labview'] },

    // electrical / embedded — skills he does NOT have, and that is exactly why
    // they belong here (see fit.mjs: a denominator blind to the asks he fails
    // is not measuring fit).
    { id: 'embedded', w: 4, a: ['embedded system', 'embedded software', 'embedded development', 'embedded c', 'microcontroller', 'mcu', 'mpu'] },
    { id: 'firmware', w: 4, a: ['firmware', 'rtos', 'bare metal', 'device driver'] },
    { id: 'cpp', w: 3, a: ['c++', 'c/c++'] },
    { id: 'circuits', w: 4, a: ['analog circuit', 'digital circuit', 'analog and digital', 'circuit design', 'signal integrity', 'power integrity', 'analog design'] },
    { id: 'pcb', w: 3, a: ['pcb', 'schematic capture', 'schematic review', 'schematic design', 'altium', 'board bring-up', 'board design'] },
    { id: 'hdl', w: 3, a: ['verilog', 'vhdl', 'systemverilog', 'rtl design', 'fpga'] },
    { id: 'labinstr', w: 2, a: ['oscilloscope', 'logic analyzer', 'spectrum analyzer', 'soldering'] },
    { id: 'embeddedos', w: 2, a: ['linux kernel', 'embedded linux', 'yocto', 'buildroot'] },

    // semiconductor / cleanroom
    { id: 'semi', w: 3, a: ['semiconductor', 'wafer', 'fab', 'cleanroom', 'clean room'] },
    { id: 'vacuum', w: 3, a: ['vacuum', 'pump down', 'leak test', 'helium leak'] },
    { id: 'process-semi', w: 2, a: ['etch', 'deposition', 'cvd', 'pvd', 'cmp', 'lithography', 'photoresist'] },
    { id: 'yield', w: 2, a: ['yield', 'defect density', 'excursion'] },
  ],
  /** Fit's own seniority words (title). */
  fitSeniorTitle: /\b(senior|sr\.?|staff|principal|lead|manager|supervisor|superintendent|director|head of|architect|fellow|iii|iv|v)\b/i,
  fitEntryTitle: /\b(intern|internship|co-?op|new ?grad|graduate|entry.?level|junior|jr\.?|university|campus|rotational|apprentice|associate|level 1|i\b)\b/i,
  /** A title in his line of work, for the "primary discipline" rule (title is lower-cased). */
  disciplineTitle: /\bengineer(ing)?\b/,
  /** A primary-role word that also answers for these ("mechatronics is robotics work by another name"). */
  // "Robot Field Engineer" (Maven), "Robotic System Integration Engineer" and
  // "Humanoid Engineer, Manipulation" (Field AI), all applied to outside Jarvis
  // (F-1044), read "Only a weak engineering signal", 4 of 28: \brobotics never
  // matches "robot" or "robotic". Robot Framework is a software test tool.
  disciplineAliases: { robotics: ['mechatronic', 'robot(?!\\s+framework)', 'humanoid'] },
  /** A title word that is the discipline only when the posting is in that field (fit.mjs classifyField). */
  disciplineInField: { manipulation: 'robotics' },
  /** Titles that carry a discipline's word for another line of work. */
  disciplineNotTitle: /\brobot\s+framework\b|\brobotic\s+process\s+automation\b|\brpa\b/,
  /** The archetype vocabulary scoreRole falls back to when no target role is in the title. */
  roleFallbackWords: ['mechanical', 'manufacturing', 'automation', 'robotics', 'process', 'equipment',
    'industrial', 'mechatronic', 'design engineer', 'test engineer', 'quality engineer'],
  roleFallbackWhy: {
    title: 'Engineering-discipline title',
    body: 'Body describes engineering work, but the title does not match a target role',
    weak: 'Only a weak engineering signal',
  },

  // ── field.mjs ─────────────────────────────────────────────────────
  /** Fields he is actively hunting — these score full marks. */
  priorityFields: ['robotics', 'ai-hardware'],
  /** Field definitions, most specific first (field.mjs explains each list). */
  fields: [
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
      // Every term here must be unambiguous ON ITS OWN (see field.mjs).
      terms: [
        'spacecraft', 'launch vehicle', 'cubesat', 'smallsat',
        'space systems', 'rocket engine', 'rocket propulsion', 'space propulsion',
        'electric propulsion', 'cryogenic propellant', 'payload fairing',
        'orbital mechanics', 'low earth orbit', 'in-orbit', 'on-orbit', 'in-space',
        'satellite constellation', 'satellite bus', 'satellite payload',
        'reaction control', 'star tracker', 'deorbit',
        'combustion device', 'thrust chamber', 'turbopump', 'engine test stand',
        // NOT 'launch site' (Amazon's relocation boilerplate).
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
      // "grid" alone matched gridlock; "fusion" alone matched Fusion 360.
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
      // The catch-all; its evidence saturates at two (see field.mjs).
      maxEvidence: 2,
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
  ],

  // ── prescreen.mjs ─────────────────────────────────────────────────
  /** Title words that place a job outside his discipline… */
  otherDiscipline: /\b(?:electrical|electronics?|power systems?|protection|substation|transmission|distribution|relay|civil|structural|geotechnical|transportation|traffic|highway|bridge|water|wastewater|stormwater|environmental|software|firmware|embedded|front[-\s]?end|back[-\s]?end|full[-\s]?stack|devops|cloud|data|machine learning|\bml\b|\bai\b|network|cyber|security|it\b|information technology|rf\b|radio|antenna|pcb|analog|digital|asic|fpga|silicon|circuit|chemical|biomedical scientist|clinical|regulatory|validation \(csv\)|computer system|hvac|mep\b|plumbing|fire protection|estimator|sales|account|marketing|procurement|buyer|supply chain analyst|planner|scheduler|nerc|compliance)\b/i,
  /** …and words that bring it back in. */
  ourDiscipline: /\b(?:new grad\w*|early career|entry[-\s]level|hardware|mechanical|mechatronic|electromechanical|manufactur\w*|production|process|equipment|tool(?:ing)?|robot\w*|automation|test|reliability|quality|design engineer|product engineer|r&d|npi|industrial|prototype|thermal|fluid|packaging|assembly|fixture|maintenance engineer|plant engineer|project engineer|systems engineer|field engineer|applications engineer|materials|metallurg\w*|composites?)\b/i,
  /** How the discipline drop names his work. */
  disciplineWork: 'mechanical, manufacturing or robotics work',

  // ── picks.mjs ─────────────────────────────────────────────────────
  /** Titles that are unambiguously somebody else's discipline (a ranking penalty). */
  notHisDiscipline: /\b(asic|rtl|verilog|vhdl|firmware|design\s+for\s+test|\bdft\b|physical design|analog design|circuit design|soc\b|software (development )?engineer|full[- ]stack|data (scientist|engineer)|machine learning engineer|cybersecurity|network engineer|cloud (hardware|infrastructure)|devops|\bsre\b)/i,
  disciplineMissWhy: 'reads as EE/CS, not mechanical',
  /** A stated pay floor at or above this, with no years stated, is a level above new grad. */
  aboveNewGradPay: 190000,
  /** What a hands-on (technician-track) role does to desirability. */
  handsOn: { bonus: 6, why: 'hands-on' },

  // ── curate.mjs ────────────────────────────────────────────────────
  /** Titles that fail his standing rules on their face. Welding/joining as the one process: his words 2026-11-06, "i dont like specific sub process welding is kinda lame". */
  titleOut: /\b(senior|sr\.?|staff|principal|manager|director|head of|intern(ship)?|co-?op|technician|operator|assembler|machinist|apprentice|night|graveyard|3rd shift|third shift)\b|\b(III|IV)\b|\bengineer\s+[3-5]\b|\bE[3-5]\b/i,
  /**
   * A TITLE CENTRED ON ONE SUB-PROCESS (his words 2026-11-06, "i dont like
   * specific sub process welding is kinda lame"): welding or joining. A title
   * that lists two or more other processes beside it ("Manufacturing Engineer
   * (Welding, Machining, Assembly)") is a broad role and stays.
   */
  subProcessTitle: /\b(?:weld|welds|welding|joining)\b/i,
  broadProcessTitle: /\b(?:machin\w*|assembl\w*|cnc|casting|mold\w*|moulding|stamping|fabricat\w*|paint\w*|coating|forming|extrusion|plating)\b/gi,
  /** Applied Materials' E2 grade: out unless a graduate or rotation program. */
  e2Out: /\bE2\b(?!E)/,
  /**
   * The employers he goes for. Since 2026-10-25 ("a lot of these companies i
   * legit dont want to work for, i wanna aim for the damn stars") this is the
   * GATE, not just the reading order: the curator files nobody else into his
   * inbox (starsOnly). Everything else stays in the library, flagged as usual;
   * a heart still keeps any job. Add a name here when he names one.
   */
  frontier: /^(tesla|applied materials|micron|amazon|kla|lam research|asml|nvidia|openai|anthropic|tsmc|intel|samsung|sk hynix|tokyo electron|xai|google|alphabet|apple|meta|microsoft|1x|figure|boston dynamics|agility|apptronik|physical intelligence|skild|sunday|machina|gradient|neuralink|atomic semi|hadrian|divergent|form energy|redwood|zipline|joby|archer|rivian|lucid|zoox|waymo|nuro|fluidstack|crusoe|lambda|cerebras|groq|tenstorrent|etched|lightmatter|psiquantum|commonwealth fusion|helion|onto innovation|axcelis|entegris|wolfspeed|lumentum|coherent|texas instruments|globalfoundries|amd|qualcomm|asm(?: international| america)?$|intuitive surgical|formlabs|field ai|applied intuition|standard bots|dexterity|path robotics|collaborative robotics|bedrock robotics|gecko robotics|the bot company|dyna robotics|genesis(?: ai)?$|persona ai|foundation robotics|weave robotics|wayve|aurora innovation|periodic labs|lila sciences|vulcanforms|radiant(?: industries| nuclear)?$|kairos power|terrapower|oklo|x-energy|fervo|base power|spacex|blue origin|astranis|nasa jet propulsion|california institute of technology jet propulsion|waabi|heron power|normal computing|matic robots)\b/i,
  /**
   * HIS EMPLOYER TASTE (quiz, 2026-10-25). The curator sorts every employer into
   * one of four classes (curate.mjs employerClass) and files only the first
   * three. "a lot of them just dont sponsor but they dont say it especially
   * legacy dinosaur companies or traditional industries, plus it looks lame …
   * in reality i want flashiness and prestige or good career."
   *   star  — `frontier` above.
   *   name  — a big name he'd put on a resume: every established chip company
   *           ("all of them"), big medtech ("big medtech is fine too"), carmakers
   *           and the big suppliers (Bosch/Denso tier), big legacy machine makers
   *           ("yes, a big name counts"), big tech hardware.
   *   role  — industrial conglomerates: "if they have a cool product or the work
   *           is cool … i do view them as dinosaurs … depend heavily on role and
   *           work"; often no sponsorship. Lincoln Electric is out ("narrow, meh").
   *   other — filed only when the posting itself names top investors or big
   *           funding ("only with top investors or big funding").
   */
  starsOnly: true,
  bigNames: /^(thermo fisher|arthrex|renesas|arm|schaeffler|festo|aeva|analog devices|western digital|onsemi|on semiconductor|nxp|microchip|infineon|stmicroelectronics|st microelectronics|broadcom|marvell|seagate|sandisk|kioxia|skyworks|qorvo|texas instruments|globalfoundries|brooks automation|azenta|veeco|ultra clean|ichor|mks instruments|advanced energy|kulicke|amkor|enphase|first solar|nextracker|qcells|hanwha|fluence|corning|coreweave|panasonic|toyota battery|xpeng|weride|pony\.ai|dyson|whoop|eight sleep|medtronic|stryker|boston scientific|abbott|johnson & johnson|johnson and johnson|j&j|edwards lifesciences|ge healthcare|siemens healthineers|philips|baxter|becton dickinson|zimmer biomet|dexcom|insulet|hologic|resmed|toyota|american honda|honda|general motors|gm\b|ford|hyundai|kia|nissan|bmw|mercedes|volkswagen|stellantis|subaru|mazda|volvo|scout motors|slate auto|bosch|robert bosch|denso|magna|zf\b|continental|aisin|ge vernova|general electric|caterpillar|john deere|deere|cummins|siemens|cnh|paccar|komatsu|hitachi|mitsubishi|kawasaki|lg energy|lg electronics|sk on|samsung sdi|hp inc|hp$|hewlett packard|dell|cisco|supermicro|super micro|ibm|oracle|dyson)\b/i,
  roleDecides: /^(ge aerospace|airbus|honeywell|3m|emerson|eaton|parker hannifin|parker|itw|illinois tool works|ingersoll rand|danaher|dover|rockwell automation|abb|schneider electric|ametek|fortive|xylem)\b/i,
  /** Contract manufacturers: "not too interested, only as backup" — read after everyone else he would file. */
  backup: /^(jabil|flex ltd|flex$|flextronics|celestica|sanmina|plexus|benchmark electronics)\b/i,
  /**
   * Employers he counts as funded though their postings name no investors
   * (his answer 2026-11-02, "Funded startups"): a known round, so survivability
   * and capital pass; moat, product and sponsorship still count. A startup on
   * a VC hiring list is NOT added here for being listed (F-948, 2026-11-05):
   * only a known funding round counts. A newly funded startup he names is added here by hand.
   */
  fundedNames: /^(re:?build|atmoszero|gander robotics|unlimited industries|thorlabs)\b/i,
  /**
   * Never filed, whatever the posting says (quiz, 2026-10-25): aerospace that is
   * defense or will not sponsor (Pratt, RTX, Textron, Gulfstream: ~0 H-1B
   * engineering petitions, or every posting says no), Lincoln Electric ("narrow,
   * meh"), HVAC and elevators, oil & gas and chemicals ("Corning yes, the rest
   * no"), Gotion, engineering services and staffing, fading consumer brands.
   */
  notHisKind: /^(lincoln electric|pratt & whitney|pratt and whitney|rtx|raytheon|collins aerospace|textron|bell textron|gulfstream|general dynamics|trane|carrier|johnson controls|otis|lennox|daikin|gotion|quest global|cyient|belcan|aerotek|tata|infosys|hcl|wipro|peloton|gopro|irobot|sonos|exxon|exxonmobil|chevron|slb|schlumberger|baker hughes|halliburton|nov\b|shell|bp\b|conocophillips|dow\b|dow chemical|dupont|air liquide|linde|air products|basf|eastman chemical|lyondellbasell)\b/i,
  /**
   * A big name is filed only on evidence it sponsors (2026-10-25: "a lot of them
   * just dont sponsor but they dont say it, especially legacy dinosaur
   * companies"). Fewer certified H-1B engineering petitions than this in the
   * coverage ledger, and no sponsorship line in the posting: not filed.
   * GE Vernova had 11 across 5,220 postings; Cummins 501; Caterpillar 60.
   */
  sponsorBar: 20,
  /**
   * A ROLE MADE FOR HIS GRADUATING CLASS NEVER FAILS ON YEARS (his rule,
   * 2026-11-06, through the first mate). Formlabs' "Manufacturing Engineer -
   * May 2027 Graduates" was cut for "1-3 years": in a program for new
   * graduates that line means internships and co-ops, and he has those
   * (Applied Materials, Acme Steel). A title naming such a program, or a posting
   * that calls itself one, skips the years bar; the graduation-window rule
   * still decides whether his class is the one it hires. ONLY a years line
   * starting at 1 or 2 ("1-3", "2+"): a new-grad title asking 3+ is still
   * mislabelled and dropped (his earlier rule, "3-5 yrs … label it new grad").
   */
  gradProgramMaxYears: 2,
  /** Robotics companies, where a required 1-2 years is a stretch, not a drop (his answer 2026-11-06, "5. ye"). */
  roboticsEmployers: ROBOTICS_EMPLOYERS,
  stretchMaxYears: 2,
  gradProgram: {
    title: /\bnew[\s-]*(?:college[\s-]*)?grad(?:uate)?s?\b|\bncg\b|\buniversity\s+(?:grad(?:uate)?s?|hires?|program)\b|\brecent\s+grad(?:uate)?s?\b|\bearly[\s-]career\b|\bgraduate\s+(?:program|engineer|rotation|development|scheme|trainee)\b|\bgraduate\s+(?:mechanical|manufacturing|process|robotics|mechatronics|design|equipment)\s+engineer\b|\bengineer,?\s*graduate\b|\brotational\s+program\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+20\d\d\s+grad(?:uate)?s?\b|\bclass\s+of\s+20\d\d\b|\b20\d\d\s+(?:new\s+)?grad(?:uate)?s?\b|\bcampus\s+hire\b/i,
    body: /\b(?:this|our|the)\s+(?:is\s+an?\s+)?(?:new[\s-]*grad(?:uate)?|university[\s-]*(?:grad(?:uate)?|hire|recruiting)|early[\s-]career|graduate|rotational|campus)\s+(?:program|role|position|opportunity|hire|hiring)\b|(?<!\bnot\s)(?<!n't\s)(?<!\bnot\s(?:been\s)?)\bdesigned\s+for\s+(?:new|recent)\s+(?:college\s+)?grad(?:uate)?s\b|\bfor\s+(?:new|recent)\s+(?:college\s+)?grad(?:uate)?s\s+(?:graduating|who\s+(?:will\s+)?graduate)\b/i,
  },
  /** He avoids test roles ("avoid test roles", 2026-10-25): test, validation, reliability. */
  testRole: /\b(test|testing|validation|verification|reliability)\s+(engineer|engineering|specialist|lead)\b|\b(test|validation|reliability)\s*\/\s*\w+\s+engineer\b|\bv&v\b/i,
  /**
   * Work he does not want, by the title alone, each with his words (the
   * reader's brief carries the same rule for a role whose title hides it).
   * Thermal, 2026-11-05: "for thermal jobs I think it's a waste of time, not
   * my interest plus no expertise". A title whose core is thermal: Thermal
   * (Systems/Design/Fluids/Management/Analysis) Engineer, "Mechanical
   * Engineer - Thermal", HVAC, heat transfer, thermodynamics. Not thermal
   * PROCESS work at a fab (furnaces, anneal: a process role) or thermal spray,
   * and not AI data-center cooling (his "all of it", 2026-10-25).
   */
  notInterest: [
    {
      key: 'thermal',
      // The thermal word (aerothermal, thermofluids too), up to three words,
      // then the role ("Thermal Integration Engineer", "Thermofluids Analyst",
      // "Thermal CAE Engineer", "Thermal Systems Design, Hybrid Powertrain") —
      // unless a word between names his own work (manufacturing, process,
      // quality, sourcing…: "Thermal Cooling Manufacturing Engineer" is a
      // manufacturing role); or the role, then thermal ("Mechanical Engineer -
      // Thermal", "Engineer - Thermal Dynamics").
      title: /\bhvac\b|\bheat[\s-]+transfer\b|\bthermodynamic\w*|\b(?:(?:aero)?thermal(?![\s-]+(?:process\w*|spray))|thermo[\s-]?fluids?)(?:[\s/&,-]+(?!(?:manufactur|process|quality|supply|sourcing|procure|mechanical|field|service|sustaining|industriali[sz]|equipment|sales|commercial)\w*)[a-z0-9]+){0,3}?(?:[\s/&,-]+(?:engineer\w*|analyst|scientist|specialist|architect|lead|designer|researcher)\b|[\s/&-]+design\b(?=\s*(?:[,(–—-]|$)))|\b(?:engineer\w*|analyst|scientist)\b[^,()]{0,30}?(?:\s*[,(–—-]\s*|\s+)\(?(?:(?:aero)?thermal(?![\s-]+(?:process\w*|spray))|thermo[\s-]?fluids?)\b/i,
      // AI and cloud data-center cooling (his "all of it", 2026-10-25); a
      // title that pairs thermal with mechanical work, which is his; and one
      // of his own roles on a thermal product ("Manufacturing Engineer 3
      // (Thermal)", "Failure Analysis Engineer - Power & Thermal").
      unless: /\b(?:data[\s-]?cent(?:er|re)s?|datacenter|liquid[\s-]+cooling|immersion|server|rack|gpu|cloud|ai[\s-]+(?:infrastructure|hardware|chip))\b|\bmechanical\s*(?:and|&|\/)\s*thermal\b|\bthermal\s*(?:and|&|\/)\s*mechanical\b|\bthermo[\s-]?mechanical\b|\b(?:manufactur\w*|process|quality|sourcing|supplier|sustaining|equipment|failure\s+analysis|field\s+service)\s+engineer/i,
      why: 'not his interest: thermal',
      said: '"for thermal jobs I think it\'s a waste of time, not my interest plus no expertise" (2026-11-05)',
    },
  ],
  /** A startup that names top investors or real money in its own posting ("$20M+ raised or 40+ people"). */
  funded: /\b(series\s+[a-f]\b|raised\s+(?:over\s+|more\s+than\s+|nearly\s+)?\$\s?\d|\$\s?\d+(?:\.\d+)?\s?(?:b|bn|billion)\b(?![^.]{0,40}\brevenue)|\$\s?(?:[2-9]\d|\d{3})\s?(?:m|mm|million)\b(?![^.]{0,40}\brevenue)|unicorn|andreessen|a16z|sequoia|founders fund|lux capital|khosla|kleiner perkins|general catalyst|thrive capital|index ventures|\baccel\b|greylock|lightspeed venture|coatue|8vc|y combinator|breakthrough energy|lowercarbon|dcvc|eclipse ventures|valor equity|bezos expeditions|google ventures)/i,
  /** Employers he has capped (the curator never files one unasked). */
  capped: /^tesla\b/i,
  curatePrompt,
  /**
   * Reader turn-downs the brief above says are NOT drops (F-767). A DROP whose
   * `why` matches `why` and not `unless` is asked once more with `rule` added.
   * The industry widening of 2026-10-08: Oceaneering's 0-2-year ME was dropped
   * "as oil and gas", Rosenbauer's for "fire-truck (heavy vehicle)
   * manufacturing". Nuclear, refinery reliability, utility operations and the
   * rest stay out, so a reason naming them is left alone.
   */
  /**
   * Words that make a hand turn-down about the employer or its product line,
   * beyond "sector", "industry", "products" (F-731): a turn-down for one of
   * these carries to the employer's same-titled posting at another site.
   */
  employerTurnDown: /\b(?:nuclear|food|beverage|buildings|building\s+(?:products?|systems|materials)|plumbing|lighting|elevators?|wiring|defen[cs]e|weapons|military|spacecraft|satellites?|launch\s+vehicles?|tobacco)\b/i,
  readerDropExceptions: [
    {
      key: 'widened-sectors',
      why: /\b(?:oil[\s-]*(?:&|and)[\s-]*gas|oilfield|offshore|subsea|drilling|energy|power\s+generation|automotive|vehicles?|trucks?|fire[\s-]?trucks?|heavy[\s-]+(?:vehicles?|machinery|equipment)|agricultur\w*|construction\s+(?:and\s+mining\s+)?equipment|mining|off[\s-]highway)\b[^.]{0,80}?\b(?:outside|not\s+(?:one\s+of\s+)?his|isn['’]t\s+(?:one\s+of\s+)?his|(?:target|his)\s+(?:industr|sector)|irrelevant|not\s+relevant)|\b(?:outside|not\s+(?:one\s+of\s+)?his|isn['’]t\s+(?:one\s+of\s+)?his)\b[^.]{0,40}?\b(?:industr|sector)\w*[^.]{0,60}?\b(?:oil|gas|energy|automotive|vehicles?|trucks?|agricultur\w*|mining|machinery)\b/i,
      unless: /\b(?:nuclear|refiner\w*|rotating\s+equipment|reliability|field\s+(?:service|role|job|engineer)|maintenance|hvac|building|plumbing|grid|transmission|substation|utility\s+operations|facilities|defen[cs]e|weapons|military|spacecraft|satellites?|launch)\b/i,
      rule: 'Vehicles and heavy machinery (automotive including non-EV, trucks, agricultural, construction and mining equipment) and energy (power generation, oil & gas equipment and plants) have been IN his sectors since 2026-10-08: an industry on that list is not a reason to drop.',
    },
  ],

  // ── skip-learn.mjs ────────────────────────────────────────────────
  /** A note naming an employer-level disqualifier: one skip is enough to propose. */
  employerLevel: [
    { re: /\b(defen[cs]e|itar|clearance|military|classified)\b/i,
      why: 'you wrote that this is a defense employer', nonUsPersonOnly: true },
    { re: /\b(no|not|does\s?n'?t|do\s?n'?t|wo\s?n'?t|cannot|can\s?n?'?t)\b[^.]{0,20}\bsponsor/i,
      why: 'you wrote that they do not sponsor', sponsorshipOnly: true },
  ],
  /** Primary-business launch/spaceflight employers. */
  launchEmployers: [
    'spacex', 'rocket lab', 'blue origin', 'firefly aerospace', 'astra space',
    'sierra space', 'stoke space', 'abl space systems', 'relativity space',
    'astro mechanica', 'ursa major', 'varda space', 'impulse space',
    'axiom space', 'vast space', 'phantom space', 'launcher',
  ],
  /** A skip note complaining the posting wanted a different degree. */
  degreeFieldTheme: /\b(electrical|ee\b|computer science|chemical|wrong degree)\b/i,
  /** Title words beyond the shared list that carry no signal in this field. */
  skipStopWords: [],
  /** Words the skip learner must never propose blocking (read by serve.mjs). */
  skipProtect: ['mechanical', 'manufacturing', 'automation', 'robotics', 'design', 'process', 'quality', 'test', 'equipment', 'systems', 'production'],
};
