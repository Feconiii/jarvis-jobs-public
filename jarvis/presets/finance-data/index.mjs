import screen from './screen.mjs';
import discovery from './discovery.mjs';
import writing from './writing.mjs';

/** What setup shows and seeds for someone who picks this preset. */
const meta = {
  id: 'finance-data',
  label: 'Finance / business / data analytics (FP&A, financial analyst, data analyst, BI)',
  defaultTargetRoles: [
    'Financial Analyst', 'FP&A Analyst', 'Data Analyst', 'Business Analyst',
    'Business Intelligence Analyst', 'Analytics Analyst',
  ],
  starterCompanies: [
    'JPMorgan Chase', 'Goldman Sachs', 'Morgan Stanley', 'Bank of America', 'Capital One',
    'American Express', 'Visa', 'Mastercard', 'BlackRock', 'Fidelity Investments',
    // Amazon, Google and EY resolved to someone else's tiny board by name
    // (2026-10-16 trial). They and Microsoft run their own careers sites, so
    // they are left to the LinkedIn pass rather than seeded here.
    'Charles Schwab', 'Deloitte', 'PwC', 'KPMG', 'Stripe', 'Ramp', 'Brex',
    'Plaid', 'Robinhood', 'Salesforce', 'Snowflake', 'Databricks',
  ],
  spSectors: 'Financials,Information Technology,Communication Services,Consumer Discretionary,Health Care,Industrials',
  starterPreferences: [
    'avoid senior, staff, principal, lead, manager, director, vp in title',
    'never intern, internship, co-op in title',
    'never sales, account executive, customer success, recruiter in title',
    'want analyst, analytics, fp&a, financial planning, business intelligence in title',
  ],
};

export default { meta, screen, discovery, writing };
