// Landing page controller: loads the prerecorded flythrough (hero.js) behind a loading bar, mounts
// the radar section (radar.js), and turns scrolling into one continuous camera move from the room
// down onto the radar. GSAP ScrollTrigger + Lenis when they loaded; a plain scroll listener if not.

const $ = (id) => document.getElementById(id);
// The tour always plays here (the system's reduce-motion setting would freeze it into a still
// overview); add ?still to the address for the still version.
const reduced = new URLSearchParams(location.search).has('still');

let hero = null, radar = null, lenis = null, inControl = false;

function progress(f) {
  const pct = Math.round(Math.max(0, Math.min(1, f)) * 100);
  $('loaderBar').style.width = `${pct}%`;
  $('loaderPct').textContent = `${pct}%`;
}

function doneLoading() {
  progress(1);
  $('loader').classList.add('done');
}

async function startHero() {
  // Never hold the page behind the loader for long: the copy and radar work without the 3D.
  const cap = setTimeout(doneLoading, 6000);
  try {
    const { mountHero } = await import('./hero.js');
    hero = await mountHero($('stage'), { motion: !reduced, onProgress: (f) => progress(0.1 + 0.9 * f) });
  } catch (err) {
    console.warn('3D flythrough unavailable:', err);
  }
  clearTimeout(cap);
  doneLoading();
  onScroll(scrollProgress());
}

async function startRadar() {
  try {
    const { mountRadar } = await import('./radar.js');
    radar = mountRadar($('measure'));
    new IntersectionObserver(([e]) => radar.setActive(e.isIntersecting), { rootMargin: '10% 0px' }).observe($('measure'));
  } catch (err) {
    console.warn('Radar unavailable:', err);
    $('measure').innerHTML = '<p class="note" style="padding:20vh 8vw">The measuring demo could not load. Open the <a href="measure.html">Measure page</a> instead.</p>';
  }
}

// ---------------------------------------------------------------------------------------
// Scroll: 0 at the top, 1 once the radar section has covered the screen.

function scrollProgress() {
  return Math.max(0, Math.min(1, scrollY / innerHeight));
}

function onScroll(p) {
  hero?.setScroll(p);
  // The room dims as the radar comes up over it, and stops drawing once it's covered.
  $('stageShade').style.opacity = String(Math.max(0, (p - 0.35) / 0.65) * 0.78);
  hero?.setPaused(scrollY > innerHeight * 1.6);
  if (!window.gsap) $('scrollHint').style.opacity = String(1 - Math.min(1, p * 5));
  // Drag-to-look only while the room fills the screen, so it never fights the radar's controls.
  $('stage').classList.toggle('control', fine && p < 0.3);
}

function wireScroll() {
  const { gsap, ScrollTrigger, Lenis } = window;
  if (gsap && ScrollTrigger) {
    gsap.registerPlugin(ScrollTrigger);
    if (Lenis && !reduced) {
      lenis = new Lenis({ lerp: 0.09, smoothWheel: true });
      lenis.on('scroll', ScrollTrigger.update);
      gsap.ticker.add((t) => lenis.raf(t * 1000));
      gsap.ticker.lagSmoothing(0);
    }
    ScrollTrigger.create({ trigger: '#hero', start: 'top top', end: 'bottom top', scrub: true, onUpdate: (st) => onScroll(st.progress) });
    gsap.to('#scrollHint', { opacity: 0, ease: 'none', scrollTrigger: { trigger: '#hero', start: 'top top', end: '15% top', scrub: true } });
    gsap.to('.hud', { opacity: 0, ease: 'none', scrollTrigger: { trigger: '#hero', start: '20% top', end: '70% top', scrub: true } });
    gsap.from('#measure', { opacity: 0, y: 80, ease: 'none', scrollTrigger: { trigger: '#measure', start: 'top bottom', end: 'top 35%', scrub: true } });
  } else {
    addEventListener('scroll', () => onScroll(scrollProgress()), { passive: true });
  }
  addEventListener('resize', () => onScroll(scrollProgress()));
  $('scrollHint').addEventListener('click', (e) => {
    e.preventDefault();
    if (lenis) lenis.scrollTo('#measure', { duration: 1.6 });
    else $('measure').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' });
  });
}

// ---------------------------------------------------------------------------------------
// No buttons: drag the room to look around it, let go and the tour picks up again. The wheel
// still scrolls the page (zoom is off). Touch screens just watch, so the page scrolls freely.

const fine = matchMedia('(pointer: fine)').matches;
let idle = null;

function wireLook() {
  const stage = $('stage');
  stage.addEventListener('pointerdown', () => {
    clearTimeout(idle);
    if (!inControl) { inControl = true; hero?.takeControl({ zoom: false }); }
  });
  addEventListener('pointerup', () => {
    if (!inControl) return;
    clearTimeout(idle);
    idle = setTimeout(() => { inControl = false; hero?.resumeTour(); }, 4000);
  });
}

progress(0.05);
wireLook();
// The CDN scripts are deferred, so they've run by the time this module does.
wireScroll();
startHero();
startRadar();
