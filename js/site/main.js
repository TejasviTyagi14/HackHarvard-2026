// Landing page controller: loads the prerecorded flythrough (hero.js) behind a loading bar, mounts
// the radar section (radar.js), and turns scrolling into one continuous camera move from the room
// down onto the radar. GSAP ScrollTrigger + Lenis when they loaded; a plain scroll listener if not.

const $ = (id) => document.getElementById(id);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

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
    hero = await mountHero($('stage'), { onProgress: (f) => progress(0.1 + 0.9 * f) });
  } catch (err) {
    console.warn('3D flythrough unavailable:', err);
    $('btnControl').hidden = true;
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
  if (!window.gsap) {
    $('heroCopy').style.opacity = String(1 - Math.min(1, p * 2.2));
    $('scrollHint').style.opacity = String(1 - Math.min(1, p * 5));
  }
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
    gsap.to('#heroCopy', { opacity: 0, y: -60, ease: 'none', scrollTrigger: { trigger: '#hero', start: 'top top', end: '45% top', scrub: true } });
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
// Buttons

function setControl(on) {
  inControl = on;
  if (on) hero?.takeControl();
  else hero?.resumeTour();
  $('stage').classList.toggle('control', on);
  $('btnControl').hidden = on;
  $('btnResume').hidden = !on;
  $('keysHint').hidden = !on;
  // While you fly the camera, the wheel zooms instead of scrolling the page.
  if (lenis) on ? lenis.stop() : lenis.start();
  document.documentElement.style.overflow = on ? 'hidden' : '';
}

function wireButtons() {
  $('btnControl').addEventListener('click', () => setControl(true));
  $('btnResume').addEventListener('click', () => setControl(false));
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && inControl) setControl(false); });
  $('btnScan').addEventListener('click', async () => {
    // The real pipeline lives on the map page; without a camera, show the measuring demo instead.
    const note = $('scanNote');
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
      note.hidden = false;
      note.textContent = 'This browser can’t open a camera here, so here’s the measuring demo instead.';
      $('scrollHint').click();
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      s.getTracks().forEach((t) => t.stop());
      location.href = 'map.html';
    } catch {
      note.hidden = false;
      note.textContent = 'Camera access was blocked. Allow it in the address bar to scan your space; meanwhile, here’s the demo.';
      $('scrollHint').click();
    }
  });
}

// The HUD clock: time since the tour started, as a recording would show it.
function tickClock() {
  const t0 = performance.now();
  const el = $('hudClock');
  const tick = () => {
    const s = (performance.now() - t0) / 1000;
    el.textContent = `T+${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
    if (!reduced) setTimeout(tick, 100);
  };
  tick();
}

progress(0.05);
wireButtons();
tickClock();
// The CDN scripts are deferred, so they've run by the time this module does.
wireScroll();
startHero();
startRadar();
