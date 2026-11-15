/**
 * hardware-engineering preset: discovery targeting. Pure data; imports nothing from jarvis/.
 * Read through jarvis/targeting.mjs, never imported directly.
 *
 * Every value here was moved VERBATIM out of the discovery scripts (2026-10-16)
 * so a second preset can supply its own. The comments that explained each one
 * came with it. The finance-data preset has the same keys.
 */
export default {
  // ── wording ───────────────────────────────────────────────────────
  /** The field, in a log line: "N US hardware/mechanical postings". */
  label: 'hardware/mechanical',
  /** One word for the field: "the title is not hardware work". */
  fieldWord: 'hardware',
  /** The role family, in a log line: "known US engineering employers". */
  familyNoun: 'engineering',

  // ── hiring-signals.mjs ────────────────────────────────────────────
  /**
   * NEVER_TRACK, the part that is about HIS field (the staffing-agency part is
   * generic and stays in hiring-signals.mjs). Regex source strings, joined
   * with '|' and compiled case-insensitive together with the generic list.
   */
  neverTrack: [
    // Listed with the staffing shops until 2026-10-16. Moved here because for a
    // business or analyst new grad they are direct employers, so the generic
    // list cannot hold them.
    'accenture', 'capgemini',
    // From the per-metro harvest the same day: agencies, and the employers a
    // keyword search drags in that will never post his kind of role.
    '\\bbank\\b', 'insurance', '\\bgeico\\b', '\\baig\\b', '\\bllp\\b', '\\bpwc\\b', '^ey$', 'deloitte', 'kpmg',
    'towne park', 'cushman', '\\bcbre\\b',
    // Building design and construction. Their "Mechanical Engineer" is HVAC and
    // plumbing for buildings, which his filters have excluded since the first day,
    // and the title alone cannot say so — Jacobs posted 31 of them in one harvest.
    '^jacobs\\b', 'kiewit', 'dlr group', '^hed$', 'mckinstry', 'bowman consulting', 'aecom',
    'burns (?:&|and) mcdonnell', 'black (?:&|and) veatch', 'stantec', '^wsp\\b', '^hdr\\b', '^arup\\b',
    'consulting engineers', 'building technologies', 'carollo', 'gray aes', '\\barchitects?\\b',
    'engineers (?:&|and) constructors', '\\bconstruction\\b',
    // Defense primes, weapons companies and the clearance-gated national labs.
    // These are filtered on the employer, not on anything the posting says — an
    // F-1 cannot hold a clearance and he does not want weapons work. Export
    // control is NOT why they are here; that stopped disqualifying anything on
    // 2026-09-19. Radiant, Vast, Impulse and Astrolab are deliberately absent.
    'lockheed', 'northrop', 'raytheon', '\\brtx\\b', 'blue origin', 'spacex', 'l3harris',
    'general dynamics', 'bae systems', 'booz allen', 'applied physics laborator', '\\bkbr\\b',
    'leidos', '\\bsaic\\b', 'mitre', 'peraton', '\\bcaci\\b', 'huntington ingalls',
    'general atomics', 'sandia', 'lawrence livermore', 'los alamos', 'lincoln laborator',
    'anduril', 'shield ai', 'firefly aerospace', 'collins aerospace', 'rocket lab',
    'sierra nevada', 'sierra space', 'kratos', 'epirus', 'castelion', 'ursa major',
    'aerovironment', 'x-bow', 'true anomaly', 'amentum', 'parsons', '\\bv2x\\b',
    'mercury systems', 'voyager technologies', 'aerospace corporation', 'draper',
    'battelle', 'textron', '\\bmoog\\b', 'elbit', 'qinetiq', 'overland ai', 'neros',
    // Weapons manufacture, by name and by word. "Defense" in a company's own name
    // is the company telling us what it builds, so it counts — but the word needs
    // its boundaries: an unanchored "ammo" matched "Mammoth Brands", a consumer
    // goods company, on the first run.
    '\\bdefen[cs]e\\b', '\\barmament', '\\bmunitions?\\b', '\\bordnance\\b', '\\bammo\\b',
    'firearms?\\b', 'sig sauer', 'smith *& *wesson', '\\bsturm,? ruger', '\\bcolt\\b',
    'barrett firearms', 'vista outdoor', 'winchester repeating',
  ],

  /**
   * Is this posting the kind of work that makes its EMPLOYER worth tracking?
   *
   * A keyword search is a hint, not a filter. "mechanical engineer" per city
   * returns Jacobs, Kiewit and thirty MEP consultancies — mechanical engineering
   * of buildings, which his filters have excluded from the first day — and
   * "systems engineer" returns a bank. Pass 2 on 2026-09-20 tracked GEICO, US
   * Bank and a valet-parking company off exactly that, 2,518 rows of insurance
   * agents and cash-vault processors, before the audit read their titles. So a
   * company is only worth resolving when something it posted is hardware work
   * and is not building services.
   */
  trackTitleRe: /\b(?:mechanical|mechatronic|electromechanical|robotic|manufacturing|hardware|automation|controls?|process|test|design|product|equipment|tooling|npi|r&d|systems?|thermal|propulsion|opto-?mechanical|quality|reliability|integration|prototype|build)\w*\b[^|]{0,40}\b(?:engineer|technician|designer)|\b(?:engineer|technician)\b[^|]{0,30}\b(?:mechanical|robotic|hardware|manufacturing)/i,
  /** A title in the field that is still not his kind of work (building services). */
  offFieldTitleRe: /\b(?:hvac|mep\b|plumbing|piping|building|construction|commissioning|facilit(?:y|ies)|water|wastewater|civil|structural|architect|fire protection|energy modeling|refrigeration|utilities|substation|transmission line|it systems?|network|software|cloud|devops|salesforce|sap\b|servicenow|cyber)/i,

  // ── discover-ats.mjs ──────────────────────────────────────────────
  // Roles at these employers are gated behind US security clearance or ITAR
  // "US person" status, which an F-1/OPT candidate cannot hold. Discovering them
  // would only fill the pipeline with postings that can never be applied to, so
  // they are never auto-added. (See modes/_profile.md for the standing rule.)
  // Applied only when the person is NOT a U.S. person (targeting.person.usPerson).
  clearanceGated: [
    'lockheed', 'northrop', 'raytheon', 'rtx', 'general dynamics', 'l3harris',
    'huntington ingalls', 'leidos', 'booz allen', 'caci', 'saic', 'palantir',
    'transdigm', 'howmet', 'axon',
    // Defence-first companies whose engineering roles are clearance- or
    // US-person-gated almost without exception. Space and energy startups are
    // deliberately NOT here: their ITAR postings get hard-blocked individually,
    // with the quote, so the applyable minority still surfaces.
    'spacex', 'blue origin', 'anduril', 'shield ai', 'general atomics',
    'sierra nevada', 'aerovironment', 'kratos', 'epirus', 'radiance technologies',
    // Added 2026-09-08 with the curated hardware seed: defence-first startups
    // that read as commercial hard-tech from the name alone, which is exactly
    // how they would otherwise slip past this gate.
    'saronic', 'castelion', 'forterra', 'overland ai', 'hidden level',
    'firestorm labs', 'scout ai', 'applied research associates',
    // Added 2026-09-09 on MEASUREMENT rather than reputation. This list's own
    // rule is that space startups stay off it, because their ITAR postings get
    // blocked one at a time and the applyable minority still reaches him. True
    // Anomaly has no applyable minority: of the first 25 postings read, **25 of
    // 25** hard-blocked — security clearance or US-person status, every one. That
    // is 182 live postings he can never hold, and the criterion this list
    // already states ("gated almost without exception") is met.
    'true anomaly',
    // Same measurement, same answer (2026-09-10): Mach Industries returned
    // **25 of 25** read postings hard-blocked on clearance or US-person status.
    'mach industries',
  ],
  /** Employers this preset never auto-adds, whoever the person is (same matching as clearanceGated). */
  skipEmployers: [],

  // Tags/industries that mean a startup actually builds physical things. YC and
  // a16z portfolios run to thousands of companies, the overwhelming majority of
  // them B2B SaaS with no mechanical-engineering surface whatsoever. Probing all
  // of them would cost hours of requests to add companies that will never post a
  // relevant role, so the seed list is filtered before any network work happens.
  // Tuned once against a real YC run. "healthcare" and "biotech" were in the
  // first version and were far too broad — YC tags every telehealth and
  // claims-billing SaaS with them, which flooded the results with companies that
  // will never post a mechanical role. "medical device" and "hard tech" capture
  // the physical-product subset without the digital-health tail.
  seedTags: [
    'hardware', 'hard tech', 'robotics', 'manufacturing', 'aerospace', 'space',
    'drones', 'autonomous', 'self-driving', 'automotive', 'electric vehicle',
    'energy', 'climate', 'nuclear', 'semiconductor', 'supply chain', 'logistics',
    'construction', 'medical device', 'medical devices', 'industrial',
    'agriculture', 'iot', '3d printing', 'materials', 'batteries',
    'transportation', 'aviation', 'mining', 'oil and gas', 'sensors',
    'manufacturing automation', 'warehouse',
  ],

  // ── discover-linkedin.mjs ─────────────────────────────────────────
  /**
   * The default searches.
   *
   * These are deliberately ROLE searches, not company searches — the whole point
   * is to find employers we cannot name yet, so naming them in the query defeats
   * it. They cover the shapes of work his files actually evidence: mechanical
   * design, manufacturing and process engineering, equipment and test, robotics
   * and automation. Overlap between them is free; the harvest dedupes by posting
   * id and the same company surfacing under four searches is a signal, not waste.
   */
  linkedinQueries: [
    'robotics engineer', 'mechanical engineer new grad', 'manufacturing engineer new grad',
    'process engineer semiconductor', 'hardware engineer new grad', 'mechanical design engineer',
    'automation engineer', 'equipment engineer', 'test engineer mechanical',
    'systems engineer new grad', 'product engineer hardware', 'manufacturing engineer robotics',
    'mechatronics engineer', 'R&D engineer mechanical', 'integration engineer hardware',
    'field service engineer semiconductor', 'process engineer new grad', 'NPI engineer',
    'validation engineer hardware', 'tooling engineer', 'applications engineer robotics',
    'design engineer entry level', 'associate mechanical engineer', 'graduate engineer',
    // Added 2026-09-20 from the LinkedIn page he pasted, where none of the titles
    // that excited him carried a "new grad" tag: a twelve-person robotics company
    // writes "Mechanical Engineer", "Prototype Engineer", "Robotics Build
    // Engineer". These are the shapes of that work, still never a company name.
    'mechanical engineer robotics', 'humanoid robot mechanical', 'robotics hardware engineer',
    'prototype engineer', 'robotics build engineer', 'electromechanical engineer',
    'actuator design engineer', 'mechanism design engineer', 'opto-mechanical engineer',
    'mechanical engineer startup', 'hardware integration engineer', 'robot technician',
    'surgical robotics mechanical', 'lab automation engineer', 'mechanical engineer medical device',
    'mechanical engineer drone', 'eVTOL mechanical engineer', 'spacecraft mechanical engineer',
    'battery manufacturing engineer', 'fusion energy engineer', 'additive manufacturing engineer',
    'thermal engineer hardware', 'packaging engineer semiconductor', 'wafer fab equipment engineer',
    'consumer electronics product design engineer', 'reliability engineer hardware',
  ],
  /**
   * The metros where hardware and robotics companies cluster.
   *
   * A guest search returns the newest few hundred results and no more, so a
   * country-wide "mechanical engineer" is truncated long before it reaches a
   * twelve-person company in Pittsburgh. Asking per metro is how the same search
   * reaches past the cut. Named by LinkedIn's own location text rather than by
   * geoId — the text resolves on the guest endpoint, and a wrong id fails silent.
   */
  metros: [
    'San Francisco Bay Area', 'Los Angeles Metropolitan Area', 'Greater Boston',
    'Greater Seattle Area', 'Austin, Texas Metropolitan Area', 'New York City Metropolitan Area',
    'Greater Pittsburgh Region', 'San Diego Metropolitan Area', 'Denver Metropolitan Area',
    'Detroit Metropolitan Area', 'Greater Phoenix Area', 'Dallas-Fort Worth Metroplex',
    'Atlanta Metropolitan Area', 'Greater Chicago Area', 'Raleigh-Durham-Chapel Hill Area',
    'Salt Lake City Metropolitan Area', 'Portland, Oregon Metropolitan Area', 'Greater Minneapolis-St. Paul Area',
  ],

  // ── discover-sources.mjs ──────────────────────────────────────────
  /** Role searches, never company names — same rule as discover-linkedin. */
  sourceQueries: [
    'mechanical engineer', 'robotics engineer', 'manufacturing engineer', 'hardware engineer',
    'mechanical design engineer', 'mechatronics', 'test engineer hardware', 'process engineer',
    'automation engineer', 'electromechanical',
  ],
  /**
   * YC's own job posts on HN: most of YC is software, so the headline has to
   * say something physical before the company is worth a resolver's time.
   */
  ycRoleHintRe: /\b(?:hardware|robot|mechanical|mechatronic|manufactur|electrical|embedded|firmware|asic|fpga|chips?|silicon|semiconductor|battery|batteries|drone|aerospace|satellite|space|rocket|propulsion|nuclear|fusion|energy|factory|factories|industrial|automation|sensor|optic|photonic|laser|biotech|lab automation|medical device|3d print|additive|materials?|machining|machinist|machine shop|cnc|eVTOL|aircraft|vehicle|automotive|physical)/i,
  /** The Muse's job categories to read (its public API takes `category` more than once). */
  museCategories: ['Science and Engineering'],

  // ── discover-radar.mjs ────────────────────────────────────────────
  /**
   * LinkedIn post searches for curated "(HIRING LIST)" posts: Grace Gong's
   * weekly On My Radar lists (sourced from Harmonic) and the reposts of them.
   * One topic per search: a bare "hiring list" search returns her legal,
   * voice and eval lists first (2026-10-31).
   */
  radarQueries: [
    'Grace Gong "HIRING LIST" robotics', 'Grace Gong "HIRING LIST" physical AI',
    'Grace Gong "HIRING LIST" industrial', 'Grace Gong "HIRING LIST" hardware chips',
    'Grace Gong "HIRING LIST" semiconductor', 'Grace Gong "HIRING LIST" autonomous',
    'Grace Gong "HIRING LIST" space aerospace', 'Grace Gong "HIRING LIST" energy climate',
    'Grace Gong "HIRING LIST" manufacturing materials', 'Grace Gong "HIRING LIST" medtech surgical',
    'Grace Gong "HIRING LIST" deep tech', 'Grace Gong "HIRING LIST" drones defense',
  ],
  /** A list whose TITLE is hardware: every company on it counts. Others count company by company (ycRoleHintRe). */
  radarListRe: /\b(?:robot\w*|physical ai|humanoid|hardware|chips?|semiconductor\w*|industrial|manufactur\w*|autonomous|self-driving|driving|space|aerospace|satellite|energy|climate|nuclear|fusion|batter\w*|materials?|deep tech|surg\w*|medtech|medical device|drones?|ev\b|electric vehicle|3d print\w*|additive)\b/i,
  /** What HN "Who is hiring" comments are searched for, per thread. */
  hnTerms: ['mechanical', 'hardware', 'robotics', 'manufacturing', 'mechatronics'],

  // ── universe.mjs ──────────────────────────────────────────────────
  /** The title a hand-supplied names list is given, so it counts as in-field evidence. */
  sampleTitle: 'mechanical engineer',
  /** The title a resolver-list company is given: hiring evidence, NOT field evidence. */
  genericTitle: 'engineer',
  /** The LinkedIn sweep's search: "<name> engineer". */
  sweepTerm: 'engineer',

  // ── lca.mjs ───────────────────────────────────────────────────────
  /** The SOC families a mechanical engineering new grad competes in. */
  socFamilies: /^(?:17-2(?:141|112|199|111|131|051|072|061)|17-3(?:027|026|029)|11-3051|17-2011)/,
  /** On a card: "N certified H-1B filings, M in mechanical/industrial engineering". */
  socLabel: 'mechanical/industrial engineering',
  /** In lca-import's acronym check: "M in engineering". */
  socShortLabel: 'engineering',

  // ── reboard.mjs ───────────────────────────────────────────────────
  /** Simplify's categories that count as his field. */
  simplifyCategoryRe: /hardware/i,
  /** S&P sectors with no surface for him (null: skip none). */
  skipSectorRe: /^(Financials|Real Estate|Communication Services)$/,
  // Sub-industries with no mechanical-engineering surface, whatever their size.
  skipSubRe: /retail|restaurant|hotel|casino|cruise|managed health|health care (services|facilities|distributors)|insurance|application software|systems software|it consulting|data processing|advertising|homebuilding|human resource|research & consulting|internet services|interactive|movies|broadcasting|publishing|cable|telecommunication|apparel|footwear|food distributors|drug retail|trading companies|consumer finance|education|leisure facilities|diversified support|real estate|reits?\b/i,

  // ── audit-new-boards.mjs ──────────────────────────────────────────
  /** Titles that mean a company makes or runs physical things. Deliberately wide. */
  auditFamilyRe: /\b(?:engineer(?:ing)?|technician|machinist|mechanic(?:al)?|robotic|mechatronic|manufactur|hardware|firmware|embedded|electrical|controls?|automation|cad\b|designer|r&d|scientist|metrology|welder|assembler|fabricat|tooling|npi\b|quality|test\b|reliability|process|avionics|propulsion|thermal|optic|semiconductor|wafer)/i,
  /** Titles that are his field specifically (a same-name software board has none). */
  auditFieldRe: /\b(?:mechanical|mechanic|manufactur\w*|hardware|robot\w*|mechatronic\w*|process\s+engineer|equipment|test\s+engineer|electrical|controls?\b|automation|fabricat\w*|assembl\w*|machin(?:ist|ing|e\s+design)|thermal|propulsion|battery|optic\w*|semiconductor|wafer|npi\b|avionics|tooling|reliability|quality\s+engineer|technician|welder|field\s+service|production|materials?\b|industrial|design\s+engineer|systems\s+engineer|firmware|embedded|structur\w*|aerospace|vehicle|powertrain|hvac|ingenieur|ingeniero|engenheiro)/i,
  /**
   * Software and IT titles (F-635). A title that also says one of these counts
   * as his field only when it carries a word from auditStrongFieldRe —
   * "Software Test Engineer", "Production Support Engineer" and "Site
   * Reliability Engineer" are IT; "Embedded Software Engineer" is not.
   * TestingXperts (IT consulting, 179 postings) passed on titles like these.
   */
  auditOffFieldRe: /\b(?:software|developer|dev\s?ops|sre\b|site reliability|cloud|azure|aws\b|gcp\b|saas|big data|hadoop|spark\b|data (?:engineer|warehouse|platform)|etl\b|middleware|server admin\w*|sys(?:tems)?\s*admin\w*|administrator|oracle|primavera|sap\b|salesforce|servicenow|workday|dynamics 365|\.net\b|java\b|python\b|react\b|angular\b|node(?:\.?js)?\b|front[- ]?end|back[- ]?end|full[- ]?stack|web\b|mobile\b|ios\b|android\b|product engineer|qa\b|quality assurance|manual test\w*|automation test\w*|test automation|selenium|testing\b|penetration|cyber\w*|security (?:engineer|analyst)|network (?:engineer|admin\w*)|help ?desk|it (?:support|specialist|technician|analyst)|production support|application support|database|dba\b|sql\b|tableau|power bi|machine learning|ml engineer|ai engineer|llm)/i,
  /** Hardware words no IT title carries; one of them keeps a title in his field. */
  auditStrongFieldRe: /\b(?:mechanical|mechanic|manufactur\w*|hardware|robot\w*|mechatronic\w*|embedded|firmware|electrical|fabricat\w*|machin(?:ist|ing|e\s+design)|thermal|propulsion|battery|optic\w*|semiconductor|wafer|npi\b|avionics|tooling|welder|powertrain|hvac|aerospace|vehicle|equipment|assembl\w*|pcb|fpga|asic|rf\b|analog)/i,
  /** The audit's reasons, worded for this field. */
  auditNoFamilyWhy: (n, total) => `${n} of ${total} titles are engineering or technical work`,
  auditOnlyOffFieldWhy: (n, total) => `all ${n} engineering titles of ${total} are software or IT (developer, cloud, testing, admin) — not a hardware employer`,
  auditNoFieldWhy: (total, n) => `0 of ${total} titles are hardware work (${n} engineering, all software or other) — a same-name board, or not a hardware employer`,
  auditOkNoun: 'engineering employers',
};
