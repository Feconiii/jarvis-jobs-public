#!/usr/bin/env node
// jarvis/setup-check.mjs — what is set up, what is missing, what still holds
// the example's values. Claude runs this first on a new clone (see CLAUDE.md
// and .claude/skills/jarvis-setup/SKILL.md) and asks only about what is left.
//
// Usage: node jarvis/setup-check.mjs [--json]
// Built-ins only, so it runs before `npm install`.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.join(HERE, '..');
const at = (p) => path.join(ROOT, p);
const read = (p) => { try { return fs.readFileSync(at(p), 'utf8'); } catch { return null; } };

/** Values that only the shipped examples carry. Still present = not yet made yours. */
const EXAMPLE_MARKS = /Alex Rivera|alex@example\.com|yourportfolio\.example|your-handle|Example Manufacturing Co\.|Example Robotics|examplesemi|Jane Smith|jane@example\.com/;

function check() {
  const items = [];
  const add = (key, ok, what, fix) => items.push({ key, ok, what, fix });

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 24, `Node.js ${process.versions.node}`, 'install Node.js 24 or newer');
  add('deps', fs.existsSync(at('node_modules/js-yaml')), 'npm packages', 'npm install');
  let claude = false;
  try { execSync(process.platform === 'win32' ? 'where claude' : 'command -v claude', { stdio: 'ignore' }); claude = true; } catch { /* not on PATH */ }
  add('claude', claude, 'Claude Code CLI (`claude`) for the writers and daily curation', 'install Claude Code and sign in once');

  const file = (key, p, what, fix, { minBytes = 1, check = null } = {}) => {
    const t = read(p);
    if (t == null || t.length < minBytes) return add(key, false, `${p} — ${what}`, fix);
    if (EXAMPLE_MARKS.test(t)) return add(key, false, `${p} — still holds the example's values`, `replace them with yours (${what})`);
    const extra = check ? check(t) : null;
    return add(key, !extra, `${p} — ${what}${extra ? ` (${extra})` : ''}`, extra ? fix : '');
  };

  file('cv', 'cv.md', 'your CV, the source of truth for everything written', 'build it with the user (skill: jarvis-setup, "Your CV")', { minBytes: 400 });
  file('apply-profile', 'data/jarvis/apply-profile.yml', 'what forms are filled with', 'copy examples/apply-profile.example.yml and fill it with the user', {
    check: (t) => (/^\s*email:\s*"?\s*"?\s*$/m.test(t) ? 'email is empty' : null),
  });
  file('portals', 'portals.yml', 'the companies you track', 'copy examples/portals.example.yml, then run discovery', {
    check: (t) => ((t.match(/^\s*-\s*name:/gm) || []).length < 5 ? 'fewer than 5 companies tracked' : null),
  });
  file('preferences', 'jarvis/preferences.md', 'your plain-English rules', 'copy examples/preferences.example.md and write the rules with the user');
  file('profile', 'config/profile.yml', 'target roles and pay floor', 'copy config/profile.example.yml and fill it with the user');
  file('resume-pool', 'jarvis/resume-pool.json', 'the resume bullet pool (verbatim from cv.md)', 'generate it from cv.md, then adjust resume-variants.mjs / resume-plan.mjs keys');

  const db = fs.existsSync(at('data/jarvis/jobs.db'));
  add('store', db, 'a job store with at least one scan', 'npm run jarvis:scan');
  return items;
}

const items = check();
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ready: items.every((i) => i.ok), items }, null, 2));
} else {
  for (const i of items) console.log(`${i.ok ? '✔' : '✖'} ${i.what}${i.ok ? '' : `\n    → ${i.fix}`}`);
  const left = items.filter((i) => !i.ok).length;
  console.log(left ? `\n${left} thing(s) left to set up.` : '\nEverything is set up. npm run jarvis:serve');
}
