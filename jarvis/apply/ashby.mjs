// jarvis/apply/ashby.mjs — Ashby adapter.
// Ashby postings (jobs.ashbyhq.com) show an overview with an "Application"
// tab; the URL form <posting>/application renders the form directly.

import { fill as coreFill } from './_form.mjs';

export const id = 'ashby';
export const matches = (url) => /jobs\.ashbyhq\.com\//i.test(url);

export async function fill(page, profile) {
  const url = page.url();
  if (!/\/application\/?(\?|$)/.test(url)) {
    await page.goto(url.replace(/\/?(\?.*)?$/, '/application'), { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  return coreFill(page, profile);
}
