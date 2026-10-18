// Section 2's "Detail" pop-up: pick Brief / Normal / Detailed and watch Droid "edit" the
// assistant's level-of-detail preset. The diff is generated from the real DETAIL_PRESETS, but it
// is only a visual: nothing is written to disk. onApply(level, detail) applies the preset for real.
import { DETAIL_PRESETS, DETAIL_SCHEMA } from '../detail.js';

const LEVELS = [['brief', 'Brief'], ['normal', 'Normal'], ['detailed', 'Detailed']];
const fmt = (v) => (typeof v === 'string' ? `'${v}'` : String(v));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The code lines for switching `from` to `to`: context lines plus - / + pairs for changes. */
export function presetDiff(from, to) {
  const a = DETAIL_PRESETS[from], b = DETAIL_PRESETS[to];
  const lines = [{ k: ' ', t: 'export const ACTIVE_DETAIL = {' }];
  for (const key of Object.keys(DETAIL_SCHEMA)) {
    if (a[key] === b[key]) lines.push({ k: ' ', t: `  ${key}: ${fmt(a[key])},` });
    else lines.push({ k: '-', t: `  ${key}: ${fmt(a[key])},` }, { k: '+', t: `  ${key}: ${fmt(b[key])},` });
  }
  lines.push({ k: ' ', t: '};' });
  return lines;
}

/**
 * button: the toggle next to the mic. anchor: the element the window sits beside.
 * onApply(level, detail): applies the chosen preset. reduced: prefers-reduced-motion.
 */
export function mountDroid({ button, anchor, onApply, reduced = false, level = 'normal' }) {
  const pop = document.createElement('div');
  pop.className = 'rs-droid';
  pop.hidden = true;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Answer detail');
  pop.innerHTML = `
    <div class="rd-head">
      <span class="rd-title">ANSWER DETAIL</span>
      <button type="button" class="rd-x" aria-label="Close">×</button>
    </div>
    <div class="rd-seg" role="radiogroup" aria-label="Level of detail">
      ${LEVELS.map(([k, n]) => `<button type="button" role="radio" data-l="${k}">${n}</button>`).join('')}
    </div>
    <div class="rd-ed">
      <div class="rd-tab"><span class="rd-dots"><i></i><i></i><i></i></span>droid · js/detail.js</div>
      <div class="rd-status" aria-live="polite"></div>
      <pre class="rd-code" aria-hidden="true"></pre>
    </div>
    <p class="rd-foot">Live Droid editing runs through tools/droid_bridge.py with your FACTORY_API_KEY</p>`;
  document.body.append(pop);
  const q = (s) => pop.querySelector(s);
  const status = q('.rd-status'), code = q('.rd-code');
  let run = 0;

  const syncSeg = () => {
    for (const b of pop.querySelectorAll('[data-l]')) {
      const on = b.dataset.l === level;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', String(on));
    }
  };
  const row = (n, l, body = esc(l.t)) => `<span class="rd-ln rd-${l.k === '-' ? 'del' : l.k === '+' ? 'add' : 'ctx'}"><span class="rd-no">${n}</span><span class="rd-mk">${l.k}</span>${body}</span>`;
  const renderLines = (lines, typing = -1, chars = 0) => {
    code.innerHTML = lines.map((l, i) => {
      if (typing >= 0 && i > typing) return '';
      if (i === typing) return row(i + 1, l, esc(l.t.slice(0, chars)) + '<span class="rd-cur"></span>');
      return row(i + 1, l);
    }).join('');
  };
  const idle = () => {
    status.innerHTML = `<span class="rd-mut">Droid ▸ idle · answers are ${level}</span>`;
    renderLines(presetDiff(level, level));
  };

  async function pick(next) {
    if (next === level) return;
    const from = level, id = ++run;
    level = next;
    syncSeg();
    const lines = presetDiff(from, next);
    if (!reduced) {
      status.innerHTML = '<span class="rd-acc">Droid ▸</span> reading js/assistant.js…';
      renderLines(presetDiff(from, from));
      await sleep(550);
      if (id !== run) return;
      status.innerHTML = '<span class="rd-acc">▸</span> editing js/detail.js';
      // Type the changed lines out over ~2 s; context lines appear instantly.
      const total = lines.filter((l) => l.k !== ' ').reduce((s, l) => s + l.t.length, 0) || 1;
      const per = 1900 / total;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].k === ' ') { renderLines(lines, i, lines[i].t.length); continue; }
        for (let c = 0; c <= lines[i].t.length; c += 2) {
          if (id !== run) return;
          renderLines(lines, i, c);
          await sleep(per * 2);
        }
      }
    }
    if (id !== run) return;
    renderLines(lines);
    status.innerHTML = `<span class="rd-ok">✓ applied</span> · answers are now ${next}`;
    onApply(next, { ...DETAIL_PRESETS[next] });
  }

  function place() {
    if (pop.hidden) return;
    if (window.matchMedia('(max-width: 640px)').matches) { pop.style.left = pop.style.top = ''; return; }
    const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    let top = r.top - h - 10;
    if (top < 12) top = Math.min(window.innerHeight - h - 12, r.bottom + 10);
    const left = Math.max(12, Math.min(window.innerWidth - w - 12, r.right - w));
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.max(12, top)}px`;
  }
  const onDoc = (e) => { if (!pop.contains(e.target) && !button.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { close(); button.focus(); } };
  function open() {
    if (!pop.hidden) return;
    pop.hidden = false;
    syncSeg();
    if (run === 0 || status.textContent === '') idle();
    place();
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', place, { passive: true });
    window.addEventListener('resize', place);
    pop.querySelector('.is-on')?.focus({ preventScroll: true });
  }
  function close() {
    if (pop.hidden) return;
    pop.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDoc, true);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('scroll', place);
    window.removeEventListener('resize', place);
  }

  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => (pop.hidden ? open() : close()));
  q('.rd-x').addEventListener('click', close);
  for (const b of pop.querySelectorAll('[data-l]')) b.addEventListener('click', () => pick(b.dataset.l));
  syncSeg();
  idle();

  return {
    open, close, get level() { return level; },
    dispose() { close(); run++; pop.remove(); },
  };
}
