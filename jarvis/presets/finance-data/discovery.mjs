/**
 * finance-data preset: discovery targeting. Pure data; imports nothing from jarvis/.
 * Read through jarvis/targeting.mjs, never imported directly.
 *
 * Same keys as presets/hardware-engineering/discovery.mjs, which documents what
 * each one is for. The values here aim the company-finding passes at employers
 * of new-grad financial, accounting, business and data analysts: banks, asset
 * managers, insurers, the Big Four, fintechs, and the finance and analytics
 * teams every large company runs.
 */
export default {
  // ── wording ───────────────────────────────────────────────────────
  label: 'finance/data',
  fieldWord: 'finance or data',
  familyNoun: 'finance and analytics',

  // ── hiring-signals.mjs ────────────────────────────────────────────
  /**
   * Added to the generic staffing-agency list. Banks, insurers, the Big Four
   * and consultancies are NOT here: they are this field's employers. What is
   * here recruits commission-only "financial professionals" under a finance
   * name, which a keyword search for analyst roles drags in.
   */
  neverTrack: [
    'primerica', 'world financial group', '\\bwfg\\b',
  ],

  /**
   * In-field titles: a finance, accounting, business or data word in front of an
   * analyst-type role ("Financial Analyst", "FP&A Analyst", "Audit Associate",
   * "Business Intelligence Analyst"), an analyst/associate role naming the field
   * after it ("Analyst, Investment Banking"), or a role that is the field on its
   * own ("Staff Accountant", "Actuary"). A bare "Analyst" or "Associate" is not
   * enough: "Sales Associate" and "Operations Associate" are mostly retail and
   * warehouse work.
   */
  trackTitleRe: /\b(?:financ\w*|fp\s?&\s?a|accounting|accounts? (?:payable|receivable)|audit\w*|tax|treasury|investment\w*|equity research|credit|risk|data|analytics?|business intelligence|bi|business|pricing|revenue|budget\w*|cost|valuation|quantitative|quant|actuarial|strateg\w*|portfolio|corporate development|m&a|underwriting|insights?|reporting|market research|economic\w*|commercial|planning|capital markets|wealth|asset management|private equity|banking|trading|compliance|operations)\b[^|]{0,40}\b(?:analyst|associate|accountant|auditor|specialist|scientist|consultant|strategist|economist|underwriter|actuary|trader|controller)s?\b|\b(?:analyst|associate)s?\b[^|]{0,30}\b(?:financ\w*|fp\s?&\s?a|data|analytics|investment|banking|markets|risk|credit|accounting|audit|tax|treasury|strategy|business intelligence)\b|\b(?:accountant|auditor|actuary|economist|underwriter|fp\s?&\s?a)\b|\bfinanc\w*\b[^|]{0,30}\b(?:rotation\w*|development program|ldp)\b/i,
  /**
   * Titles that pass the test above and are still not the work: retail and
   * branch banking, commission sales, customer service, warehouse operations,
   * and the engineering and software roles that carry "data" or "business".
   */
  offFieldTitleRe: /\b(?:sales (?:associate|representative|rep)|retail|store|cashier|teller|warehouse|fulfil?lment|customer (?:service|support|success)|call center|collections?|loan officer|mortgage loan|insurance agent|licensed (?:insurance|agent)|financial (?:advisor|adviser|professional|representative)|wealth advisor|recruit\w*|software|engineer|developer|devops|data entry|banker|branch|driver|technician)/i,

  // ── discover-ats.mjs ──────────────────────────────────────────────
  /**
   * Employers whose roles are gated on a security clearance or U.S.-person
   * status — finance and analyst roles included. Applied only when the person
   * is NOT a U.S. person (discover-ats.mjs), so a citizen's discovery reaches
   * them.
   */
  clearanceGated: [
    'lockheed', 'northrop', 'raytheon', 'rtx', 'general dynamics', 'l3harris',
    'huntington ingalls', 'leidos', 'booz allen', 'caci', 'saic', 'palantir',
    'bae systems', 'peraton', 'mitre', 'anduril',
  ],
  skipEmployers: [],

  /** YC / VC seed tags that mean a startup is in finance, accounting or analytics. */
  seedTags: [
    'fintech', 'finance', 'financial services', 'banking', 'payments', 'insurance',
    'insurtech', 'accounting', 'analytics', 'business intelligence', 'data analytics',
    'investing', 'wealth management', 'asset management', 'lending', 'credit',
    'neobank', 'tax', 'compliance', 'regtech', 'proptech', 'real estate', 'procurement',
    'spend management', 'treasury', 'capital markets', 'trading',
  ],

  // ── discover-linkedin.mjs ─────────────────────────────────────────
  /** Role searches, never company names. */
  linkedinQueries: [
    'financial analyst', 'financial analyst new grad', 'FP&A analyst', 'data analyst',
    'data analyst entry level', 'business analyst', 'business analyst new grad',
    'investment banking analyst', 'business intelligence analyst', 'risk analyst',
    'corporate finance analyst', 'accounting associate', 'staff accountant', 'revenue analyst',
    'treasury analyst', 'equity research associate', 'credit analyst', 'pricing analyst',
    'analytics associate', 'audit associate', 'tax associate', 'valuation analyst',
    'investment analyst', 'strategy analyst', 'operations analyst', 'reporting analyst',
    'financial planning analyst', 'commercial finance analyst', 'quantitative analyst',
    'portfolio analyst', 'underwriting analyst', 'market research analyst',
    'finance rotational program', 'finance leadership development program',
    'compliance analyst', 'M&A analyst', 'private equity analyst', 'cost analyst',
  ],
  /** Where finance, banking and analytics employers cluster (LinkedIn's own location text). */
  metros: [
    'New York City Metropolitan Area', 'Greater Chicago Area', 'Charlotte Metro',
    'Greater Boston', 'San Francisco Bay Area', 'Greater Seattle Area',
    'Dallas-Fort Worth Metroplex', 'Los Angeles Metropolitan Area', 'Atlanta Metropolitan Area',
    'Washington DC-Baltimore Area', 'Greater Philadelphia', 'Greater Houston',
    'Denver Metropolitan Area', 'Greater Minneapolis-St. Paul Area', 'Miami-Fort Lauderdale Area',
    'Austin, Texas Metropolitan Area', 'Greater Phoenix Area', 'Salt Lake City Metropolitan Area',
  ],

  // ── discover-sources.mjs ──────────────────────────────────────────
  sourceQueries: [
    'financial analyst', 'data analyst', 'business analyst', 'fp&a', 'business intelligence',
    'accountant', 'risk analyst', 'investment analyst', 'analytics', 'corporate finance',
  ],
  /** A YC job post is read only when its headline names this kind of role. */
  ycRoleHintRe: /\b(?:financ\w*|fp&a|accounting|accountant|analyst|analytics|data analy\w*|data scien\w*|business intelligence|bi\b|risk|credit|treasury|investment|pricing|revenue|strategy|quant\w*|actuar\w*|underwrit\w*|economist|controller|bizops|business operations)/i,
  /**
   * The Muse's categories (its public API's own names). If The Muse renames
   * one, the source returns nothing for it and says so as a refusal or an
   * empty run; check https://www.themuse.com/developers/api/v2 for the list.
   */
  museCategories: ['Accounting and Finance', 'Data and Analytics', 'Business Operations'],
  hnTerms: ['finance', 'financial analyst', 'data analyst', 'analytics', 'fp&a', 'accounting'],

  // ── universe.mjs ──────────────────────────────────────────────────
  sampleTitle: 'financial analyst',
  /** Hiring evidence, not field evidence: a bare "analyst" does not pass trackTitleRe. */
  genericTitle: 'analyst',
  sweepTerm: 'analyst',

  // ── lca.mjs ───────────────────────────────────────────────────────
  /**
   * SOC families (2018 SOC, plus the codes older LCA files still use):
   *   13-2011 Accountants & Auditors · 13-2031 Budget Analysts · 13-2041 Credit Analysts
   *   13-2051 Financial & Investment Analysts · 13-2052 Personal Financial Advisors
   *   13-2054 Financial Risk Specialists · 13-2098 (O*NET transitional: financial and
   *   investment analysts, risk specialists, other financial specialists) · 13-2099
   *   Financial Specialists, All Other · 13-1111 Management Analysts · 13-1161 Market
   *   Research Analysts · 15-2031 Operations Research Analysts · 15-2041 Statisticians ·
   *   15-2051 Data Scientists · 15-1211 Computer Systems Analysts (15-1121 before 2018) ·
   *   11-3031 Financial Managers · 41-3031 Securities, Commodities & Financial Services
   *   Sales Agents.
   * Matched as a prefix, so "13-2051.00" counts.
   */
  socFamilies: /^(?:13-20(?:11|31|41|51|52|54|98|99)|13-11(?:11|61)|15-20(?:31|41|51)|15-1211|15-1121|11-3031|41-3031)/,
  socLabel: 'finance, accounting and data analysis',
  socShortLabel: 'finance/data',

  // ── reboard.mjs ───────────────────────────────────────────────────
  /**
   * Simplify's new-grad list has no finance or business category (seen in its
   * listings: Quant, Software, AI/ML/Data, Hardware, Product, Software
   * Engineering, Data Science, AI & Machine Learning), so the nearest are used:
   * Quant and the data categories.
   */
  simplifyCategoryRe: /quant|data/i,
  /** Every sector hires financial and data analysts: none skipped. */
  skipSectorRe: null,
  skipSubRe: null,

  // ── audit-new-boards.mjs ──────────────────────────────────────────
  /** Titles that mean the company employs office, business or analyst staff at all. Deliberately wide. */
  auditFamilyRe: /\b(?:analyst|analytics|financ\w*|accounting|accountant|auditor|audit|tax|treasury|controller|fp&a|data|business|strategy|consultant|associate|economist|actuar\w*|underwrit\w*|risk|compliance|investment|banking|scientist|product manager|operations|engineer(?:ing)?)/i,
  /** Titles that are finance, accounting or data analysis specifically. */
  auditFieldRe: /\b(?:financ\w*|fp\s?&\s?a|accounting|accountant|audit\w*|tax\b|treasury|controller|investment|banking|equity|credit|risk|valuation|pricing|revenue|budget|actuar\w*|underwrit\w*|economist|quant\w*|data analy\w*|data scien\w*|analytics|business intelligence|bi\s+(?:analyst|developer)|business analyst|strategy|portfolio|wealth|capital markets|trading|insights|reporting analyst)/i,
  auditNoFamilyWhy: (n, total) => `${n} of ${total} titles are business, finance or analyst work`,
  auditNoFieldWhy: (total, n) => `0 of ${total} titles are finance or data work (${n} business or office roles, none of them finance) — a same-name board, or not an employer of analysts`,
  auditOkNoun: 'employers of analysts',
};
