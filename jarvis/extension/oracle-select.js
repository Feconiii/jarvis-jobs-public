/**
 * ORACLE'S LIST BOX, SET THROUGH ITS OWN REACT PROPS (P2, 2026-11-07).
 *
 * 57 of the 61 Oracle list failures in his captures are one widget, Oracle
 * Recruiting's `cx-select`: a React combobox mounted from a Knockout binding
 * whose props carry the FULL option list (`options`) and the model's own
 * setter (`valueObserver`, a Knockout observable; `onValueChange`, the form's
 * change handler). The menu shows a filtered window of twelve rows, and the
 * right one was often not in it. When the menu path has found nothing, these
 * run IN THE PAGE'S WORLD (where React's fiber is visible): read the box's
 * option labels; later, after the content script has checked once more that
 * the box is still untouched, set one. The read-back decides whether it held.
 *
 * SAFETY (review, 2026-11-07):
 *   - THE BOX'S OWN LIST ONLY. The walk up the fiber stops at the FIRST fiber
 *     carrying an option list, and uses it only when that fiber OWNS this box:
 *     its props name the box's id (id / inputId / elementId), or its first DOM
 *     node is the box's own .cx-select-container. An ancestor's form model
 *     (another field, perhaps self-identification or pay) is refused.
 *   - A list given as a function is read only as a plain Knockout observable
 *     (its .peek()), never by calling something unknown.
 *   - The set names the option's LABEL as well as its index, and refuses when
 *     the list now says something else there (it can reload between calls).
 *   - valueObserver alone when present; onValueChange only as the fallback.
 *   - (second review) Ownership by container also needs the container to hold
 *     exactly one input. The set looks at the box once more right before the
 *     setter, in the page: his mark (data-jarvis-his) or a value it was not
 *     told it may hold, and nothing is written.
 * Each function is SELF-CONTAINED (chrome.scripting.executeScript sends only
 * its source) and never throws.
 */

/** {ok, labels} — the box's own option list, as text — or {ok:false, why}. */
function oracleSelectRead(inputId) {
  try {
    const el = document.getElementById(String(inputId || ''));
    if (!el) return { ok: false, why: 'no box' };
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    if (!key) return { ok: false, why: 'no React fiber on the box' };
    const labelOf = (o) => (o && typeof o === 'object' ? String(o.label ?? o.text ?? o.name ?? o.value ?? '') : String(o ?? '')).replace(/\s+/g, ' ').trim();
    for (let f = el[key], d = 0; f && d < 40; f = f.return, d += 1) {
      const p = f.memoizedProps;
      if (!p || typeof p !== 'object' || !('options' in p)) continue;
      // The first fiber with an option list: it must be THIS box's — named by
      // its id, or drawing the box's own container, which holds this one box.
      const named = [p.id, p.inputId, p.elementId].some((x) => x != null && String(x) === el.id);
      let host = f.child; for (let n = 0; host && n < 50 && !(host.stateNode && host.stateNode.nodeType === 1); n += 1) host = host.child;
      const box = typeof el.closest === 'function' ? el.closest('.cx-select-container') : null;
      const alone = !!box && typeof box.querySelectorAll === 'function' && box.querySelectorAll('input').length === 1;
      if (!named && !(box && alone && host && host.stateNode === box)) return { ok: false, why: 'the nearest option list is not this box\'s' };
      const raw = Array.isArray(p.options) ? p.options : (typeof p.options === 'function' && typeof p.options.peek === 'function' ? p.options.peek() : null);
      if (!Array.isArray(raw)) return { ok: false, why: 'the option list is not a plain list' };
      if (typeof p.valueObserver !== 'function' && typeof p.onValueChange !== 'function') return { ok: false, why: 'no setter' };
      return { ok: true, labels: raw.slice(0, 3000).map(labelOf) };
    }
    return { ok: false, why: 'no option list above the box' };
  } catch (e) { return { ok: false, why: String((e && e.message) || e).slice(0, 80) }; }
}

/**
 * Set option `index`, which must still be labelled `label`. {ok, label} or {ok:false, why}.
 * `guard` {before, wanted}: what the box may hold at the moment of the set —
 * empty, what it held before the menu attempts, or (only while it is not
 * focused) the text those attempts typed. Anything else, or the box marked as
 * his (data-jarvis-his, set by the content script on his own keys and clicks),
 * and nothing is written. No guard, no set.
 */
function oracleSelectSet(inputId, index, label, guard) {
  try {
    const el = document.getElementById(String(inputId || ''));
    if (!el) return { ok: false, why: 'no box' };
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    if (!key) return { ok: false, why: 'no React fiber on the box' };
    const labelOf = (o) => (o && typeof o === 'object' ? String(o.label ?? o.text ?? o.name ?? o.value ?? '') : String(o ?? '')).replace(/\s+/g, ' ').trim();
    for (let f = el[key], d = 0; f && d < 40; f = f.return, d += 1) {
      const p = f.memoizedProps;
      if (!p || typeof p !== 'object' || !('options' in p)) continue;
      const named = [p.id, p.inputId, p.elementId].some((x) => x != null && String(x) === el.id);
      let host = f.child; for (let n = 0; host && n < 50 && !(host.stateNode && host.stateNode.nodeType === 1); n += 1) host = host.child;
      const box = typeof el.closest === 'function' ? el.closest('.cx-select-container') : null;
      const alone = !!box && typeof box.querySelectorAll === 'function' && box.querySelectorAll('input').length === 1;
      if (!named && !(box && alone && host && host.stateNode === box)) return { ok: false, why: 'the nearest option list is not this box\'s' };
      const raw = Array.isArray(p.options) ? p.options : (typeof p.options === 'function' && typeof p.options.peek === 'function' ? p.options.peek() : null);
      if (!Array.isArray(raw)) return { ok: false, why: 'the option list is not a plain list' };
      const i = Number(index);
      if (!Number.isInteger(i) || i < 0 || i >= raw.length) return { ok: false, why: 'no such option' };
      const o = raw[i];
      const want = String(label ?? '').replace(/\s+/g, ' ').trim();
      if (!want || labelOf(o) !== want) return { ok: false, why: 'the list changed: that option is not there now' };
      const value = o && typeof o === 'object' && 'value' in o ? o.value : o;
      // THE LAST LOOK, right before the setter: in this same task nothing else can run.
      if (!guard || typeof guard !== 'object') return { ok: false, why: 'no guard' };
      if (typeof el.hasAttribute === 'function' && el.hasAttribute('data-jarvis-his')) return { ok: false, why: 'box changed: he touched it' };
      const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
      const now = norm(el.value);
      const focused = typeof document !== 'undefined' && document.activeElement === el;
      const typed = !focused && (Array.isArray(guard.wanted) ? guard.wanted : []).some((w) => norm(w) && now === norm(w));
      if (!(now === '' || now === norm(guard.before) || typed)) return { ok: false, why: 'box changed' };
      if (typeof p.valueObserver === 'function') p.valueObserver(value);
      else if (typeof p.onValueChange === 'function') p.onValueChange(value);
      else return { ok: false, why: 'no setter' };
      return { ok: true, label: labelOf(o) };
    }
    return { ok: false, why: 'no option list above the box' };
  } catch (e) { return { ok: false, why: String((e && e.message) || e).slice(0, 80) }; }
}

globalThis.__jarvisOracleSelect = { oracleSelectRead, oracleSelectSet };
