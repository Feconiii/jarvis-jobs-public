// jarvis/settings.mjs — the few numbers he can change from the dashboard.
//
// Kept in data/jarvis/settings.json (gitignored, his data), never in code.
// Unknown keys are ignored and every value is clamped to its range, so a bad
// write cannot make a run read a thousand postings.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { STORE_DIR } from './store.mjs';

export const SETTINGS = {
  // Fresh fits each scheduled daily search (6:30 AM, 4:10 PM) files even when
  // the inbox is at its target (approved 2026-11-03: "proceed with those ideas").
  dailyTopUp: { default: 10, min: 0, max: 30, label: 'New fits added each scheduled search, even with a full inbox' },
  // THE READER'S DAILY ALLOWANCE ON THE SHARED PLATFORMS (F-979, first mate's
  // call 2026-11-04, his to overrule). Every Workday, iCIMS or Oracle tenant is
  // a different employer's site: each gets its own day, under a ceiling for the
  // whole platform. A tenant that refuses still cools down on its own (F-961).
  pacePerTenant: { default: 150, min: 10, max: 1000, label: 'Postings read per employer site per day (Workday, iCIMS, Oracle)' },
  paceWorkdayCeiling: { default: 4000, min: 100, max: 10000, label: 'Postings read per day across all Workday sites' },
  paceIcimsCeiling: { default: 1500, min: 100, max: 5000, label: 'Postings read per day across all iCIMS sites' },
  paceOracleCeiling: { default: 3000, min: 100, max: 10000, label: 'Postings read per day across all Oracle sites' },
  paceJobviteCeiling: { default: 1000, min: 100, max: 5000, label: 'Postings read per day across all Jobvite sites' },
  paceTenantConcurrency: { default: 2, min: 1, max: 4, label: 'Reads in flight at once on one employer site' },
  // NEW POSTINGS' SHARE OF EACH SITE'S DAY (F-1000, first mate's call
  // 2026-11-04, his to overrule): until the release hour (UTC) the backlog may
  // not spend this share; then whatever is left goes to the backlog.
  paceFreshReservePct: { default: 40, min: 0, max: 80, label: 'Share of each site\'s daily reads kept for postings first seen in the last 3 days (%)' },
  paceFreshReleaseUtc: { default: 20, min: 1, max: 24, label: 'Hour (UTC) the unused share goes back to older postings' },
};

export const settingsPath = (dir = STORE_DIR) => path.join(dir, 'settings.json');

/** Every setting with its value (stored, else the default), clamped. */
export function readSettings(file = settingsPath()) {
  let stored = {};
  try { stored = JSON.parse(readFileSync(file, 'utf8')) || {}; } catch { stored = {}; }
  const out = {};
  for (const [k, s] of Object.entries(SETTINGS)) out[k] = clamp(k, stored[k] ?? s.default);
  return out;
}

export function clamp(key, value) {
  const s = SETTINGS[key];
  if (!s) return undefined;
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(s.max, Math.max(s.min, n)) : s.default;
}

/** Change known settings; returns the saved set. */
export function writeSettings(patch, file = settingsPath()) {
  const next = readSettings(file);
  for (const [k, v] of Object.entries(patch || {})) if (k in SETTINGS) next[k] = clamp(k, v);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}
