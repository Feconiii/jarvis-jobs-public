/**
 * THE FILL STOPS ON A POSTING THE VISA GATE BARS (his "1. ye", 2026-11-12, to
 * First Mate's recommendation): citizens or green card only, a U.S. person
 * with no licence route, or an employer that will not sponsor. The extension
 * fills nothing, shows the posting's own sentence and offers "Fill anyway",
 * which he presses; the choice stays his, every time.
 *
 * The reasons are the triage's work-authorization block (the same sentence
 * fit.blockers carries for it) and picks.mjs exportBar, the gate his inbox
 * already uses. This is NOT added to fit.blockers: that would turn the band
 * to "blocked", take the row out of his deck and need a rescore, and triage
 * flags, it never hides. His own "never/no" rules and a graduation window stay
 * where F-773 put them: the panel's Fill button asks about those once, and
 * the toolbar press does not stop for them.
 *
 * A posting with no description has no export reading: `read` says so, and
 * nothing is invented in its place.
 */
import { exportBar } from './picks.mjs';

const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const clip = (s, n = 180) => (s.length > n ? `${s.slice(0, n - 3)}…` : s);
// The bar is named by what its sentence says (First Mate's review): export
// control only when the sentence is about export control.
const EXPORTISH = /\bITAR\b|International\s+Traffic\s+in\s+Arms|\bEAR\b|\bexport|\bU\.?\s?S\.?\s+persons?\b|deemed\s+export/i;
const barLabel = (quote) => (!quote || EXPORTISH.test(quote) ? 'Export control with no licence route' : 'Citizens or permanent residents only');

export function fillStop(job) {
  const reasons = [];
  if (!job) return { reasons, read: false };
  const block = job.triage?.flags?.hardBlock ? (job.triage?.visa?.block || {}) : null;
  const blockQuote = squash(block?.quote);
  if (block) {
    const reason = block.reason || 'Work-authorisation restriction';
    reasons.push(blockQuote ? `${reason} — "${clip(blockQuote)}"` : reason);
  }
  const body = String(job.description || '');
  const read = !!body.trim();
  let bar = null;
  if (read) { try { bar = exportBar(job.title, body); } catch { bar = null; } }
  const barQuote = squash(bar);
  // exportBar answers with the warning's key when the posting's sentence was
  // not kept; that is still a bar, said without a quote.
  const bare = /^[a-z_]+$/.test(barQuote);
  // The same sentence already named by the block is said once.
  if (barQuote && !(blockQuote && !bare && (blockQuote.includes(barQuote) || barQuote.includes(blockQuote)))) {
    reasons.push(bare ? barLabel('') : `${barLabel(barQuote)} — "${clip(barQuote)}"`);
  }
  return { reasons, read };
}
