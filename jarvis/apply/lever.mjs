// jarvis/apply/lever.mjs — Lever adapter.
// Lever's application form lives at <posting-url>/apply (the posting page
// itself only has an "Apply" button). Navigate there, then run the core.

import { fill as coreFill } from './_form.mjs';

export const id = 'lever';
export const matches = (url) => /jobs\.(eu\.)?lever\.co\//i.test(url);

export async function fill(page, profile) {
  const url = page.url();
  if (!/\/apply\/?(\?|$)/.test(url)) {
    await page.goto(url.replace(/\/?(\?.*)?$/, '/apply'), { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  return coreFill(page, profile);
}
