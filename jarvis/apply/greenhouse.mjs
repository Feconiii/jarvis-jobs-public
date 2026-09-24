// jarvis/apply/greenhouse.mjs — Greenhouse adapter (thin wrapper).
// The form lives on the job page itself; the generic core does the rest.

import { fill as coreFill } from './_form.mjs';

export const id = 'greenhouse';
export const matches = (url) => /greenhouse\.io\//i.test(url);

export async function fill(page, profile) {
  return coreFill(page, profile);
}
