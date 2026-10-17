/**
 * finance-data preset: writing targeting. Pure data; imports nothing from jarvis/.
 * Read through jarvis/targeting.mjs, never imported directly.
 *
 * Field wording only. There is no `examplesOwner`: nobody's sent answers,
 * letters or stories are quoted to this preset's writers, so every prompt is
 * built from the person's own files (cv.md, profile.yml, the answer corpus).
 */
export default {
  examplesOwner: null,
  visaNotes: null,

  // What to lead with, per role type (resume tailor, tailor-llm.mjs).
  roleEmphasis: {
    fpa: 'budgeting, forecasting, variance analysis, financial modeling, three-statement models, month-end and quarterly reporting, Excel (pivot tables, lookups, scenario models), PowerPoint for management reporting',
    'financial-analyst': 'financial statement analysis, financial modeling, valuation (DCF, comparable companies), Excel, industry and company research, investment memos, PowerPoint',
    data: 'SQL, Python or R, data cleaning, Tableau or Power BI dashboards, statistics, A/B testing, KPI definition and reporting, Excel',
    business: 'requirements gathering, process mapping, KPI definition, stakeholder reporting, SQL, Excel, Tableau or Power BI, process improvement',
    accounting: 'reconciliations, journal entries, GAAP, accruals, audit support, ERP systems, Excel',
    risk: 'credit analysis, risk metrics, portfolio analysis, regulatory reporting, Excel, SQL, Python',
  },

  field: 'finance and analytics',
  resumeKind: 'professional',
  roleTypes: 'fpa | financial-analyst | data | business | accounting | risk | other',
  impression: 'this person has worked with real data and real numbers and produced analysis that someone used to make a decision',
  substance: 'Concrete analysis and its result beat generic process language every time.',
  skillExamples: 'Excel, SQL, Python, R, Tableau, Power BI, Financial Modeling, DCF Valuation, Forecasting, Variance Analysis, Bloomberg, PowerPoint',
  answerRegister: 'Clear, professional prose: what the problem or question was, what data or model the applicant worked with, what they found or built, and what it changed, with its number. No jargon for its own sake and no step-by-step narration.',
  seniorReader: 'someone more experienced in the field',
  // The word a LinkedIn people search uses for "someone on the team" (outreach.mjs).
  searchRole: 'analyst',
};
