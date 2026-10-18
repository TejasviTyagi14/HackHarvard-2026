// Decorative motion for measure.html: cards fade and rise in as they enter the viewport,
// new object rows / list items slide in, and distance readouts flash softly when they change.
// No per-frame loops: one IntersectionObserver, one MutationObserver, CSS does the animating.
// The lists are rebuilt with innerHTML on every refresh, so each item is tracked by a key and
// a running animation is carried over to the replacement element with a negative delay.

const root = document.documentElement;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

function setupReveal() {
  const targets = document.querySelectorAll('.topbar, .view, .stage > .hint, .card');
  if (reduced || !('IntersectionObserver' in window)) return;
  root.classList.add('fx');
  // Inside the landing page's iframe the implicit root is the top-level viewport, so cards
  // reveal as the parent page scrolls them into view.
  const io = new IntersectionObserver((entries) => {
    const shown = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top || a.boundingClientRect.left - b.boundingClientRect.left);
    shown.forEach((e, i) => {
      const el = e.target;
      el.style.setProperty('--fx-delay', `${Math.min(i * 70, 420)}ms`);
      el.classList.add('fx-shown');
      io.unobserve(el);
      // Drop the classes once settled so nothing lingers (e.g. a transform on the card).
      setTimeout(() => {
        el.classList.remove('fx-reveal', 'fx-shown');
        el.style.removeProperty('--fx-delay');
      }, 1300 + Math.min(i * 70, 420));
    });
  }, { threshold: 0.06, rootMargin: '0px 0px -4% 0px' });
  for (const el of targets) {
    el.classList.add('fx-reveal');
    io.observe(el);
  }
}

const IN_MS = 600, TICK_MS = 800, FORGET_MS = 1500;

/** Watches a rebuilt-on-refresh list. keyOf(el) names an item; valueOf(el) reads its distance. */
function track(container, keyOf, valueOf) {
  if (!container) return;
  const items = new Map(); // key -> { born, seen, text, base, tick }
  const pass = () => {
    const now = performance.now();
    let fresh = 0;
    for (const el of container.children) {
      const key = keyOf(el);
      if (key == null) continue;
      let it = items.get(key);
      const text = valueOf ? valueOf(el) : null;
      if (!it) {
        it = { born: now + Math.min(fresh++ * 60, 360), text, base: parseFloat(text), tick: -1e9 };
        items.set(key, it);
      } else if (text != null && text !== it.text) {
        const v = parseFloat(text);
        const moved = Number.isFinite(v) && Number.isFinite(it.base) ? Math.abs(v - it.base) >= Math.max(0.02 * Math.abs(it.base), 0.01) : true;
        if (moved) { it.tick = now; it.base = v; }
        it.text = text;
      }
      it.seen = now;
      const age = now - it.born;
      if (age < IN_MS) {
        el.classList.add('fx-in');
        el.style.setProperty('--fx-t', `${Math.round(-age)}ms`);
      }
      const since = now - it.tick;
      if (since < TICK_MS && age >= IN_MS) {
        el.classList.add('fx-tick');
        el.style.setProperty('--fx-k', `${Math.round(-since)}ms`);
      }
    }
    for (const [k, it] of items) if (now - it.seen > FORGET_MS) items.delete(k);
  };
  new MutationObserver(pass).observe(container, { childList: true });
  pass();
}

const $ = (id) => document.getElementById(id);
const textOf = (sel) => (el) => el.querySelector(sel)?.textContent.trim() ?? null;
const emptyKey = (el) => (el.classList.contains('empty') ? `empty:${el.textContent.trim()}` : null);

function setupLists() {
  if (reduced) return;
  track($('objRows'), (el) => el.dataset.id ?? emptyKey(el), textOf('td:nth-child(2) b'));
  track($('pairList'), (el) => emptyKey(el) ?? el.querySelector('.between')?.textContent.trim(), textOf(':scope > b'));
  track($('pinList'), (el) => emptyKey(el) ?? el.querySelector('[data-pin]')?.dataset.pin, textOf('b'));
  track($('sampleList'), (el) => el.textContent.trim());
  track($('talkLog'), (el) => `${[...el.parentNode.children].indexOf(el)}:${el.className}`);
}

setupReveal();
setupLists();
