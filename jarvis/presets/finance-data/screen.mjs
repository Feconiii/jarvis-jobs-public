/**
 * finance-data preset: screen targeting. Pure data; imports nothing from jarvis/.
 * Read through jarvis/targeting.mjs, never imported directly.
 *
 * The same keys as presets/hardware-engineering/screen.mjs, filled for a new
 * graduate in finance, accounting, economics, business or data analytics:
 * financial analyst, FP&A, corporate finance, investment banking, equity
 * research, asset / wealth management, credit and risk, treasury, accounting
 * and audit, revenue and pricing, data / business / BI analyst, analytics
 * engineering (adjacent) and consulting analyst roles.
 *
 * The rules each list obeys are the hardware preset's, explained in the module
 * that reads it: word-boundary matching where the module uses it, and a
 * posting is only ever FLAGGED by these, never dropped from the store.
 */

// ── triage.mjs ──────────────────────────────────────────────────────

/** Soft relevance words. triage matches these as SUBSTRINGS, so each one must not sit inside a common word ("excel" is in "excellent"). */
const relevanceSignals = [
  'financial analyst', 'finance', 'financial planning', 'fp&a', 'forecast', 'budget',
  'variance', 'financial model', 'valuation', 'dcf', 'investment banking', 'equity research',
  'asset management', 'wealth management', 'portfolio', 'credit analy', 'credit risk', 'underwriting',
  'treasury', 'accounting', 'audit', 'gaap', 'reconciliation', 'month-end', 'financial reporting',
  'pricing', 'revenue analy', 'data analyst', 'business analyst', 'analytics', 'business intelligence',
  'dashboard', 'sql', 'python', 'tableau', 'power bi', 'looker', 'microsoft excel', 'kpi',
  'insights', 'a/b test', 'statistic', 'consulting', 'm&a', 'capital markets', 'fixed income',
  'bloomberg', 'capital iq', 'factset', 'risk analy', 'economic',
];

// ── fit.mjs: skill vocabulary ───────────────────────────────────────
//
// Matched as words with fit.mjs's closed inflection set (s, es, ed, ing, er,
// ers, or, ors, ion, ions, al, ics, ic, e) on the right, so an alias must be
// written so that its common forms are that alias plus one of those.
const skills = [
  // spreadsheets / modelling
  { id: 'excel', w: 2, a: ['excel', 'microsoft excel', 'spreadsheet', 'pivot table', 'vlookup', 'xlookup', 'index match'] },
  { id: 'financial-modeling', w: 4, a: ['financial model', 'financial modeling', 'financial modelling', 'three-statement', '3-statement', 'operating model', 'lbo'] },
  { id: 'valuation', w: 3, a: ['valuation', 'dcf', 'discounted cash flow', 'comparable compan', 'trading comps', 'precedent transaction'] },
  { id: 'forecasting', w: 3, a: ['forecast', 'budgeting', 'financial planning', 'fp&a', 'rolling forecast', 'annual operating plan'] },
  { id: 'variance', w: 2, a: ['variance analysis', 'budget vs actual', 'budget-to-actual', 'budget to actual', 'actuals'] },
  { id: 'vba', w: 2, a: ['vba', 'excel macro', 'visual basic', 'macros'] },

  // accounting / reporting
  { id: 'reporting', w: 2, a: ['financial reporting', 'financial statement', 'management reporting', '10-k', '10-q', 'sec reporting'] },
  { id: 'gaap', w: 3, a: ['gaap', 'us gaap', 'ifrs', 'revenue recognition', 'asc 606', 'asc 842'] },
  { id: 'accounting', w: 3, a: ['accounting', 'general ledger', 'journal entry', 'journal entries', 'month-end close', 'month end close', 'reconciliation', 'accrual'] },
  { id: 'audit', w: 2, a: ['audit', 'internal control', 'sox', 'sarbanes-oxley', 'assurance'] },
  { id: 'tax', w: 1, a: ['tax return', 'tax provision', 'taxation', 'tax compliance'] },

  // markets / credit / risk
  { id: 'credit', w: 3, a: ['credit analysis', 'credit risk', 'underwriting', 'loan portfolio', 'credit memo', 'credit rating'] },
  { id: 'risk', w: 2, a: ['risk management', 'market risk', 'operational risk', 'value at risk', 'stress test', 'model risk'] },
  { id: 'capital-markets', w: 2, a: ['capital markets', 'fixed income', 'equities', 'derivative', 'portfolio management', 'asset allocation'] },
  { id: 'ma', w: 3, a: ['m&a', 'mergers and acquisitions', 'due diligence', 'pitch book', 'pitchbook'] },
  { id: 'bloomberg', w: 2, a: ['bloomberg terminal', 'bloomberg'] },
  { id: 'capiq', w: 2, a: ['capital iq', 'capiq', 'factset', 'refinitiv', 'morningstar direct'] },
  { id: 'pricing', w: 2, a: ['pricing analysis', 'pricing strategy', 'revenue management', 'unit economics'] },

  // data / analytics
  { id: 'sql', w: 3, a: ['sql', 'postgres', 'postgresql', 'mysql', 'bigquery', 't-sql'] },
  { id: 'python', w: 3, a: ['python', 'pandas', 'numpy', 'jupyter'] },
  { id: 'r', w: 2, a: ['r programming', 'rstudio', 'tidyverse', 'python or r', 'r or python', 'python/r', 'r/python'] },
  { id: 'tableau', w: 3, a: ['tableau'] },
  { id: 'powerbi', w: 3, a: ['power bi', 'powerbi', 'dax', 'power query'] },
  { id: 'looker', w: 2, a: ['looker', 'lookml', 'qlik', 'qlikview', 'domo', 'sigma computing'] },
  { id: 'bi', w: 2, a: ['business intelligence', 'dashboard', 'data visualization', 'data visualisation'] },
  { id: 'statistics', w: 3, a: ['statistic', 'regression', 'hypothesis testing', 'econometric', 'time series'] },
  { id: 'abtest', w: 3, a: ['a/b test', 'ab test', 'experimentation', 'experiment design'] },
  { id: 'kpi', w: 2, a: ['kpi', 'key performance indicator', 'metrics definition'] },
  { id: 'dbt', w: 2, a: ['dbt', 'data build tool'] },
  { id: 'warehouse', w: 2, a: ['snowflake', 'redshift', 'databricks', 'data warehouse'] },
  { id: 'etl', w: 2, a: ['etl', 'elt', 'data pipeline', 'airflow'] },
  { id: 'ml', w: 2, a: ['machine learning', 'predictive model', 'scikit-learn', 'sklearn'] },

  // systems
  { id: 'erp', w: 2, a: ['sap', 'oracle', 'netsuite', 'workday financials', 'erp'] },
  { id: 'epm', w: 3, a: ['hyperion', 'anaplan', 'adaptive insights', 'workday adaptive', 'oracle epm', 'onestream', 'planful', 'pigment'] },
  { id: 'salesforce', w: 1, a: ['salesforce', 'crm'] },
  { id: 'powerpoint', w: 1, a: ['powerpoint', 'presentation', 'storytelling'] },
  { id: 'consulting', w: 2, a: ['client engagement', 'stakeholder management', 'consulting'] },

  // licences — asks a new grad usually does not meet yet, which is why they
  // belong in the denominator (see fit.mjs on the embedded skills).
  { id: 'cpa', w: 3, a: ['cpa', 'certified public accountant'] },
  { id: 'cfa', w: 2, a: ['cfa', 'chartered financial analyst'] },
  { id: 'finra', w: 2, a: ['series 7', 'series 63', 'series 79', 'series 65', 'sie exam', 'finra licens'] },

  // software engineering — the asks that make a role somebody else's
  { id: 'swe', w: 3, a: ['java', 'javascript', 'typescript', 'c++', 'golang', 'kubernetes', 'microservice'] },
  { id: 'bigdata', w: 2, a: ['spark', 'pyspark', 'scala', 'hadoop', 'kafka'] },
];

// ── curate.mjs: the reader's brief ──────────────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const startLabel = (g) => (g.month >= 12 ? `${MONTHS[0]} ${g.year + 1}` : `${MONTHS[g.month]} ${g.year}`);
const STATUS = {
  f1: 'F-1 student, will need OPT then H-1B sponsorship.',
  visa: 'On a work visa, will need H-1B sponsorship.',
  citizen: 'U.S. citizen.',
  permanent_resident: 'U.S. permanent resident.',
  no_sponsorship_needed: 'Authorized to work in the U.S. without sponsorship.',
};

/** A plain description of their degree level, for the degree bar. */
const levelRule = (level) => (/^(phd|doctor)/i.test(level) ? ''
  : /^master/i.test(level) ? ' A doctorate required: DROP.'
    : ' Master\'s, MBA or PhD required: DROP.');

/**
 * The curator's brief for this field: the hardware brief's structure and bars,
 * rewritten for finance and analytics, and driven by `person`.
 */
function curatePrompt(person, job, description, cvShort, prior = []) {
  const name = person.firstName || person.fullName;
  const major = person.major || 'finance, accounting, economics, business or analytics';
  const now = new Date();
  const graduated = person.gradDate.year * 12 + person.gradDate.month <= now.getFullYear() * 12 + now.getMonth() + 1;
  const when = graduated ? `Graduated ${person.gradLabel}, available to start now.`
    : `Graduates ${person.gradLabel}, can start ${startLabel(person.gradDate)}.`;
  const status = `${STATUS[person.workAuth] || STATUS.no_sponsorship_needed} ${when}`;

  // Work authorization is only ever written in when it can decide something.
  let auth = '';
  if (person.needsSponsorship) {
    auth += `WORK AUTHORIZATION — ${name} will need visa sponsorship:
   - DROP any no-sponsorship statement: "will not sponsor", "No Visa Sponsorship", "must be authorized to work without sponsorship now or in the future".
   - DROP U.S. citizenship or permanent residency (green card) required.
   - A posting that says nothing about sponsorship is read as usual; never infer a refusal from silence.
`;
  }
  if (!person.usPerson) {
    auth += `   - DROP any mention of ITAR / International Traffic in Arms Regulations, and a "U.S. person" requirement in any wording (U.S. citizen, lawful permanent resident, asylee, refugee, "protected individual under 8 U.S.C. 1324b(a)(3)").
   - NOT a drop: a routine export-licensing review line ("…may have to go through an export licensing review"). Quote it in the note.
`;
  }

  return `You are curating job postings for ${person.fullName}. Read the ENTIRE description below and decide.

THEIR FACTS (the only facts you may use about ${name}):
${cvShort}
Status: ${status}

BOTH BARS MUST HOLD FOR KEEP:
1. Qualified as written.
   - Degree: a Bachelor's in ${major}, or in finance, accounting, economics, business administration, business analytics, statistics, mathematics, information systems or data science, or "a business / quantitative / related field" generally, passes. If it lists only other disciplines (engineering, computer science for a software role, nursing, law, the sciences) with none of these and no general business or quantitative field: DROP.${levelRule(person.degreeLevel)}
   - Licences and certifications: a CPA, CFA charter or FINRA licence REQUIRED AT HIRE that the facts above do not show: DROP. "CPA-eligible", "pursuing", "obtain within N months of hire" and "exam paid for by the firm" are not bars — the employer pays for those exams for new analysts.
   - Years: "0", "0-2", new grad, entry level, campus / analyst program, "internships count" pass. Preferred years up to 2 are fine.
     A RANGE THAT STARTS AT ZERO PASSES, whatever its top: "0-3", "0–5", "0+" all include no experience. The upper number is the band they hire across, not a bar.
     ONE YEAR IS A MAYBE, NOT A DROP. A REQUIRED "1 year" or "1+": MAYBE. A REQUIRED "1-2": MAYBE only when the posting itself says internships or academic projects count toward it; otherwise DROP. For either MAYBE the note STARTS with the years line quoted word for word. A REQUIRED "1-3", "2+" or more: DROP. A years line under "Minimum qualifications", "Required" or "What we're looking for" IS required unless that line itself says preferred. THREE OR MORE YEARS PREFERRED COUNTS AS REQUIRED: DROP. A "new grad" or "entry level" title that asks for 3+ years anywhere: DROP.
   - "Associate" means different levels in different places. At an investment bank, private equity fund or hedge fund an Associate is the post-analyst rung (2-3 years as an analyst, or an MBA): DROP unless the posting says it is a campus / undergraduate hire. A Big 4 or accounting-firm audit, tax or advisory Associate, and an "Associate Analyst", are entry level: read as usual.
   - A graduation window excluding ${person.gradLabel}: DROP. Internships, summer analyst and summer associate programs, and co-ops: DROP.
2. Relevant: the work is ANALYSIS — financial analysis, FP&A and corporate finance, investment banking, equity research, asset and wealth management, credit and risk, treasury, accounting and audit, revenue and pricing, data analysis, business analysis, business intelligence, analytics engineering, or consulting analyst work — at a bank, asset manager, insurer, fintech, consulting or accounting firm, or the finance / analytics team of any other company. DROP sales and business development, account executive, customer service and call-centre roles, bank teller and branch banking, insurance or financial-advisor roles paid on commission ("build your book of business", "uncapped commission"), recruiting, collections, bookkeeping and data entry, administrative assistants, and software / data / machine-learning ENGINEERING that asks for production software experience.
Also DROP: commission-only or "unlimited earning potential" pay; night or weekend-only schedules; an active security clearance required at hire.
${auth}MAYBE (not KEEP): heavy travel (consulting at 50%+), a role that mixes analysis with sales or client service, an analyst role whose duties are mostly report generation, or a real doubt you can name.
A POSTING THAT STATES NO REQUIREMENTS — no degree, no years, no qualifications — cannot be checked against bar 1: DROP, never MAYBE. Nothing goes on the list that the description does not prove ${name} qualifies for.

ALREADY AT THIS COMPANY (applied, in their list, rejected or hidden): ${prior.length ? prior.join('; ') : 'nothing'}
The same or nearly the same title already on that list: DROP, and say which. A title that differs only in the CITY or SITE it names is a separate opening at another site, not a duplicate: read it as usual. Each entry names its site: one marked OTHER SITE is a separate opening he would apply to, never a duplicate, and neither is an entry with the same title that was [rejected] at another site. Drop as a duplicate only the same title at the SAME SITE, the same requisition, or the same title he [hidden].

POSTING: ${job.company} — ${job.title} — ${job.location || ''}
---
${String(description || '').slice(0, 14000)}
---

Answer with ONE line of JSON and nothing else:
{"verdict":"KEEP"|"MAYBE"|"DROP","why":"<the deciding fact, one line>","note":"<KEEP/MAYBE only: two plain sentences for their card. First: the concrete overlap with ${name}'s experience above. Second: why ${name} can win it, quoting the posting's years or new-grad words. For MAYBE start with the catch. No hype.>"}`;
}

export default {
  // ── triage.mjs ────────────────────────────────────────────────────
  /**
   * Senior / lead / management titles. "Staff Accountant" and "Staff Auditor"
   * are the entry rung in accounting, so "staff" only counts before other words.
   */
  seniorTitle: /\b(senior|sr\.?|staff(?!\s+(?:accountant|auditor|accounting|tax|assurance))|principal|lead|distinguished|manager|supervisor|director|head\s+of|vp|vice\s+president|chief|managing\s+director|partner|controller|cfo)\b/i,
  /** Entry-level wording (title or body). Plain "associate" is NOT here: at a bank it is the rung above analyst. */
  entryTitle: /\b(new\s+grad(uate)?|entry[-\s]?level|early\s+career|university\s+(hire|grad)|campus|(?:analyst|associate|accountant)\s+(i|1)\b|associate\s+(?:financial|data|business|analyst|accountant)|junior|jr\.?|graduate\s+(analyst|program)|analyst\s+(?:development\s+)?program|rotational|rotation\s+program|development\s+program|staff\s+(?:accountant|auditor)|(?:audit|tax|assurance|advisory)\s+associate)\b/i,
  /** New-grad wording. */
  newGradTitle: /\b(new\s+col?lege\s+grad(uate)?s?|new\s+grad(uate)?s?|recent\s+grad(uate)?s?|university\s+(grad(uate)?|hire|recruiting)|campus\s+hire|graduate\s+(program|scheme|analyst)|early\s+career|full[-\s]time\s+analyst|analyst\s+(?:development\s+)?program|rotational\s+(?:\w+\s+)?program|(?:financial\s+|finance\s+)?leadership\s+development\s+program|class\s+of\s+20\d\d)\b/i,
  relevanceSignals,
  /** A title naming their kind of degree subject: +10 relevance. */
  majorSignals: /\b(financ\w*|accounting|accountant|economics?|analyst|analytics|business|fp&a|treasury|audit\w*|actuar\w*|statistic\w*)\b/i,
  /** A body that opens the posting to their whole field: +10 relevance. */
  relevanceAcceptsAll: /\ball\s+majors\b|accepts?\s+(all\s+)?business/i,
  /** The front-line / clerical track: a different career from analysis. */
  handsOnTitle: /\b(teller|cashier|universal\s+banker|personal\s+banker|customer\s+service|call\s+center|contact\s+center|data\s+entry|clerk|receptionist|bookkeeper|collector|collections\s+(?:agent|specialist|representative)|warehouse|driver|technician)\b/i,
  /** A title word that always makes it professional. */
  professionalTitle: /\b(analyst|accountant|auditor|economist|actuary)\b/i,

  // ── degree.mjs ────────────────────────────────────────────────────
  /** Disciplines that read as "they qualify". */
  hisDisciplines: [
    'finance', 'financial', 'accounting', 'accountancy',
    'economics', 'econ', 'applied economics', 'business economics',
    'business', 'business administration', 'business management', 'commerce',
    'business analytics', 'analytics', 'data analytics', 'data science',
    'statistics', 'mathematics', 'math', 'applied mathematics',
    'information systems', 'management information systems', 'mis',
    'quantitative finance', 'financial engineering', 'operations research',
    'actuarial science', 'management science',
  ],
  /** Not theirs, and "or related field" cannot reach them from here. */
  farDisciplines: [
    'mechanical', 'mechanical engineering', 'electrical', 'electrical engineering', 'ee',
    'civil', 'civil engineering', 'chemical engineering', 'aerospace', 'aerospace engineering',
    'biomedical', 'biomedical engineering', 'materials science',
    'nursing', 'pharmacy', 'medicine', 'law', 'journalism', 'graphic design',
    'architecture', 'biology', 'chemistry', 'social work',
  ],
  /** Not theirs, but close enough that "or related field" plausibly includes them. */
  adjacentDisciplines: [
    'computer science', 'cs', 'computer engineering', 'software engineering',
    'industrial engineering', 'physics', 'information technology',
    'marketing', 'supply chain', 'supply chain management', 'operations management',
    'public policy', 'political science', 'psychology', 'real estate',
  ],
  /** "MS Office" / "MS Excel" is software, not a Master of Science. */
  notADegree: /\bMS[\s-]+(?:Office|Excel|Word|PowerPoint|Access|Project|Outlook|Teams|Dynamics|Visio|SQL|365)\b/i,

  // ── eligibility.mjs ───────────────────────────────────────────────
  /** A degree line naming their field. */
  hisField: /\b(financ\w*|accounting|accountancy|economics?|business|commerce|statistics|mathematics|math|data (science|analytics)|analytics|information systems|\bmis\b|quantitative|actuarial|operations research)\b/i,
  /** Somebody else's degree; only used to detect a list that excludes them. */
  otherField: /\b(mechanical|electrical|electronic|civil engineer\w*|chemical engineer\w*|aerospace|biomedical|computer (science|engineering)|software engineering|nursing|pharmacy|biology|chemistry|architecture|juris doctor|law degree)\b/i,
  /** Their field named generically ("a quantitative or business field", "any major"). */
  genericField: /\b(?:quantitative|analytical|business)[- ](?:related\s+)?(?:field|discipline|degree|major|area|background)s?\b|\bany\s+(?:business\s+)?(?:major|discipline|field)\b|\ball\s+majors\b/i,
  /** Titles that are unambiguously another track's work. */
  otherTitle: /\b(software (development )?engineer|\bsde\b|full[- ]stack|front[- ]end|back[- ]end|web developer|devops|\bsre\b|firmware|mechanical engineer|electrical engineer|civil engineer|manufacturing engineer|process engineer|nurse|pharmacist|physician|teller|cashier|sales (representative|associate|development|executive)|account executive|business development representative|\bsdr\b|\bbdr\b|recruit\w*|insurance agent|loan officer|mortgage (loan )?officer|paralegal|attorney|graphic designer|warehouse|driver|technician)\b/i,
  /** Other-track words that only count when the title does not also name their work. */
  softOtherTitle: /\b(machine learning|data engineer|sales|marketing|customer (?:success|service)|call center|financial advisor|wealth advisor|product manager|operations)\b/i,
  /** A title that names their work. */
  hisTitle: /\b(analyst|analytics|fp&a|financial planning|finance|financial|accountant|accounting|audit\w*|tax|treasury|investment|equity research|credit|risk|valuation|pricing|actuar\w*|business intelligence|\bbi\b|insights|economist|consultant)\b/i,
  subjectExcludedReason: 'names degree subjects and none is finance, accounting, economics, business or a quantitative field',

  // ── fit.mjs ───────────────────────────────────────────────────────
  skills,
  fitSeniorTitle: /\b(senior|sr\.?|staff(?!\s+(?:accountant|auditor|accounting|tax|assurance))|principal|lead|manager|supervisor|director|head of|vice president|vp|managing director|partner|controller|fellow|iii|iv|v)\b/i,
  fitEntryTitle: /\b(intern|internship|co-?op|new ?grad|graduate|entry.?level|junior|jr\.?|university|campus|rotational|analyst program|staff accountant|staff auditor|associate analyst|level 1|i\b)\b/i,
  /** The title is lower-cased before this is tried. */
  disciplineTitle: /\b(analyst|analytics|accountant|associate|consultant)\b/,
  /** A primary-role word (5+ letters) that also answers for these. */
  disciplineAliases: { financial: ['finance', 'fp&a'], business: ['analytics'] },
  /** A title word that is the discipline only when the posting is in that field (fit.mjs classifyField). None in this field. */
  disciplineInField: {},
  /** Titles that carry a discipline's word for another line of work. None in this field. */
  disciplineNotTitle: null,
  roleFallbackWords: ['financial', 'finance', 'fp&a', 'accounting', 'accountant', 'audit', 'treasury',
    'investment', 'equity research', 'credit', 'valuation', 'pricing', 'data analyst',
    'business analyst', 'analytics', 'business intelligence', 'consulting'],
  roleFallbackWhy: {
    title: 'Finance / analytics title',
    body: 'Body describes finance or analytics work, but the title does not match a target role',
    weak: 'Only a weak finance / analytics signal',
  },

  // ── field.mjs ─────────────────────────────────────────────────────
  /** Fields this preset hunts first. */
  priorityFields: ['fpa', 'investment-banking', 'data-analytics'],
  /**
   * Most specific first. Every term must be unambiguous ON ITS OWN: "insurance"
   * and "tax" sit in every benefits paragraph ("health insurance", "pre-tax
   * 401(k)"), so neither is a term by itself.
   */
  fields: [
    {
      key: 'investment-banking',
      label: 'Investment banking & markets',
      weight: 5,
      terms: [
        'investment banking', 'investment bank', 'm&a', 'mergers and acquisitions', 'capital markets',
        'leveraged finance', 'equity capital markets', 'debt capital markets', 'restructuring group',
        'pitch book', 'pitchbook', 'sales and trading', 'equity research', 'private equity',
        'transaction advisory', 'deal team',
      ],
    },
    {
      key: 'asset-management',
      label: 'Asset & wealth management',
      weight: 4,
      terms: [
        'asset management', 'asset manager', 'wealth management', 'portfolio management',
        'investment management', 'hedge fund', 'mutual fund', 'etf', 'asset allocation',
        'private wealth', 'institutional investors', 'fund accounting', 'assets under management',
      ],
    },
    {
      key: 'fpa',
      label: 'FP&A & corporate finance',
      weight: 4,
      terms: [
        'fp&a', 'financial planning and analysis', 'financial planning & analysis',
        'corporate finance', 'budgeting', 'forecasting', 'variance analysis', 'operating plan',
        'long-range plan', 'annual plan', 'financial forecast', 'controllership',
      ],
    },
    {
      key: 'fintech',
      label: 'Fintech & payments',
      weight: 4,
      terms: [
        'fintech', 'payments', 'payment processing', 'digital banking', 'neobank',
        'cryptocurrency', 'blockchain', 'lending platform', 'card issuing',
        'buy now pay later', 'interchange', 'money movement',
      ],
    },
    {
      key: 'consulting',
      label: 'Consulting & advisory',
      weight: 3,
      terms: [
        'management consulting', 'strategy consulting', 'consulting firm', 'client engagements',
        'advisory services', 'case team', 'engagement team', 'deal advisory', 'consulting analyst',
      ],
    },
    {
      key: 'data-analytics',
      label: 'Data & analytics',
      weight: 3,
      terms: [
        'data analyst', 'data analytics', 'business intelligence', 'analytics engineer',
        'sql', 'tableau', 'power bi', 'looker', 'dashboard', 'dashboards', 'data visualization',
        'a/b test', 'a/b testing', 'dbt', 'snowflake', 'business analyst',
      ],
    },
    {
      key: 'accounting',
      label: 'Accounting & audit',
      weight: 3,
      terms: [
        'accounting', 'audit', 'assurance', 'gaap', 'cpa', 'general ledger', 'month-end close',
        'reconciliation', 'reconciliations', 'tax compliance', 'tax provision', 'sox',
        'external audit', 'internal audit', 'accounts payable', 'accounts receivable',
      ],
    },
    {
      key: 'insurance-risk',
      label: 'Insurance, credit & risk',
      weight: 3,
      // The catch-all for risk work; it saturates like the hardware `industrial` field.
      maxEvidence: 2,
      terms: [
        'insurer', 'insurance carrier', 'property and casualty', 'property & casualty', 'reinsurance',
        'actuarial', 'underwriting', 'claims analyst', 'credit risk', 'market risk', 'model risk',
        'credit analyst', 'credit analysis', 'loan portfolio', 'stress testing', 'risk analyst',
      ],
    },
  ],

  // ── prescreen.mjs ─────────────────────────────────────────────────
  /** Title words that place a job outside their track… */
  otherDiscipline: /\b(?:mechanical|electrical|civil|structural|chemical|aerospace|manufacturing|hardware|firmware|embedded|software|front[-\s]?end|back[-\s]?end|full[-\s]?stack|devops|cloud|network|cyber|it support|help\s*desk|nurse|nursing|clinical|pharmac\w*|sales|account executive|marketing|recruit\w*|customer (?:service|support|success)|teller|cashier|warehouse|driver|technician|hvac|plumbing|construction)\b/i,
  /** …and words that bring it back in. */
  ourDiscipline: /\b(?:new grad\w*|early career|entry[-\s]level|analyst|analytics|financ\w*|fp&a|accounting|accountant|audit\w*|tax|treasury|investment|equity|credit|risk|pricing|revenue|valuation|business intelligence|\bbi\b|data|insights|economist|actuar\w*|consult\w*|strategy|controller)\b/i,
  disciplineWork: 'finance, accounting or analytics work',

  // ── picks.mjs ─────────────────────────────────────────────────────
  notHisDiscipline: /\b(software (development )?engineer|\bsde\b|full[- ]stack|front[- ]end|back[- ]end|devops|\bsre\b|machine learning engineer|data engineer|firmware|mechanical engineer|electrical engineer|sales (representative|executive|associate)|account executive|recruiter|teller)\b/i,
  disciplineMissWhy: 'reads as engineering or sales, not finance or analytics',
  /** IB analyst bases sit near $110-125K; a stated floor of $160K+ is hiring above new grad. */
  aboveNewGradPay: 160000,
  /** The teller / clerk track is not the career this preset is for. */
  handsOn: { bonus: -10, why: 'front-line / clerical track' },

  // ── curate.mjs ────────────────────────────────────────────────────
  titleOut: /\b(senior|sr\.?|staff(?!\s+(?:accountant|auditor|accounting|tax|assurance))|principal|manager|director|head of|vice president|vp|managing director|partner|intern(ship)?|co-?op|summer analyst|summer associate|teller|cashier|night|graveyard|3rd shift|third shift)\b|\b(III|IV)\b|\b(?:analyst|associate|accountant)\s+[3-5]\b/i,
  /** No pay-grade rule in this field. */
  e2Out: null,
  /** Employers read first. */
  frontier: /^(goldman sachs|morgan stanley|jpmorgan|jp morgan|j\.p\. morgan|bank of america|citi|citigroup|wells fargo|blackrock|blackstone|kkr|apollo|carlyle|evercore|lazard|centerview|moelis|pjt|guggenheim|jefferies|houlihan lokey|fidelity|vanguard|charles schwab|t\. rowe price|bridgewater|citadel|two sigma|jane street|d\. e\. shaw|de shaw|point72|millennium|mckinsey|boston consulting|bcg|bain|deloitte|pwc|pricewaterhousecoopers|ey|ernst|kpmg|stripe|ramp|brex|plaid|robinhood|visa|mastercard|american express|capital one|paypal|block|chime|affirm|google|alphabet|apple|amazon|microsoft|meta|nvidia|netflix|salesforce|snowflake|databricks|openai|anthropic)\b/i,
  /** No employer is capped for this user. */
  capped: null,
  curatePrompt,
  /** Reader turn-downs this brief says are not drops (F-767): none beyond the generic licence and zero-year checks. */
  readerDropExceptions: [],
  /** Field words that make a hand turn-down employer-level (F-731); the generic ones suffice here. */
  employerTurnDown: null,

  // ── skip-learn.mjs ────────────────────────────────────────────────
  employerLevel: [
    { re: /\b(no|not|does\s?n'?t|do\s?n'?t|wo\s?n'?t|cannot|can\s?n?'?t)\b[^.]{0,20}\bsponsor/i,
      why: 'you wrote that they do not sponsor', sponsorshipOnly: true },
    { re: /\b(mlm|pyramid|commission[- ]only|scam)\b/i,
      why: 'you wrote that this employer is commission-only or not a real employer' },
  ],
  launchEmployers: [],
  degreeFieldTheme: /\b(engineering|computer science|cs degree|nursing|wrong degree|cpa required)\b/i,
  /** "Analyst" is in every title this preset wants, like "engineer" in the other. */
  skipStopWords: ['analyst', 'analysts'],
  skipProtect: ['finance', 'financial', 'analyst', 'analytics', 'data', 'accounting', 'investment', 'business', 'planning', 'reporting', 'risk', 'credit', 'treasury'],
  // The employer-taste lists (curate.mjs employerVerdict, hardware preset
  // 2026-10-26) are his own; this person has stated none. null = no list,
  // which employerVerdict reads as "nothing decided by name".
  starsOnly: false,
  bigNames: null,
  roleDecides: null,
  backup: null,
  notHisKind: null,
  funded: null,
  // Employers counted as funded by name; none chosen for this field.
  fundedNames: null,
  gradProgram: null,
  gradProgramMaxYears: null,
  roboticsEmployers: null,
  stretchMaxYears: null,
  subProcessTitle: null,
  broadProcessTitle: null,
  sponsorBar: null,
  testRole: null,
  notInterest: [],
};
