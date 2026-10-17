// jarvis/resume-names.mjs — the file name he chose for one posting's resume.
//
// WHY (2026-09-27). "can we add a feature we can change name of resume before
// attaching, for example company name is humanoid but the pdf resume says
// Thehumanoid that might rub them wrong". The name a recruiter sees is built
// from the company as the store knows it (resume-for-job.mjs personFile), and
// a board slug made it wrong. The store is fixed where a name was a slug; this
// is his override for the rest — kept per posting, used by every route the
// file takes (the panel's preview and Download, "Put it in the slot", the
// fill's own attach), since all of them read the one endpoint that names it.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RESUME_NAMES = path.join(HERE, '..', 'data', 'jarvis', 'resume-names.json');

function readAll(file) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) || {} : {}; } catch { return {}; }
}

/**
 * A name a file system and an ATS will both take: no path characters, one
 * ".pdf" at the end, at most 120 characters. Empty means "back to the default".
 */
export function cleanResumeName(name) {
  let s = String(name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/(\.pdf)+$/i, '').trim();
  if (!s || /^\.+$/.test(s)) return '';
  return `${s.slice(0, 116).trim()}.pdf`;
}

export function getResumeName(id, { file = RESUME_NAMES } = {}) {
  if (id == null || id === '') return '';
  return String(readAll(file)[String(id)] || '');
}

/** Save his name for this posting; an empty one removes it. Returns what is stored. */
export function setResumeName(id, name, { file = RESUME_NAMES } = {}) {
  if (id == null || id === '') throw new Error('which posting?');
  const all = readAll(file);
  const clean = cleanResumeName(name);
  if (clean) all[String(id)] = clean; else delete all[String(id)];
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2));
  renameSync(tmp, file);
  return clean;
}
