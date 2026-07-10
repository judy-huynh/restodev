/* Layout module: STORY — the editorial magazine. The page scrolls; the map
   follows. A featured hero leads, large media-led cards follow in sections
   beside a sticky companion map, and a closing CTA band hands off to the
   intake.

   Same contract as every layout (documented in layouts/atlas.js):
   mount(ctx) → view. Sections come from the optional `section` schema role
   (Memphis maps it to `era`); without one, stories group by year.

   Scroll-sync is deliberately fail-soft: prefers-reduced-motion (or any
   error in the sync path) degrades to a static map that only highlights,
   never flies — reading must never depend on the map keeping up. */
import { roleField, fieldOption, storyText, storyColor } from '../config.js';
import { esc, byline, emptyState } from '../ui/render.js';
import { openStoryOverlay, closeStoryOverlay, openLightbox } from '../ui/detail.js';
import { icon } from '../ui/icons.js';

const $ = id => document.getElementById(id);

export const strings = {
  pinHint: 'Tap the map to place this story',
  backToMap: '← Back to the stories',
  // no welcomeHint: the hero already says what this page is
};

const QUOTE_CHARS = 160;
const CARD_CHARS = 260;

export function mount({ tenant, mode, mapCtl, onStoryOpen, onShare }) {
  let stories = [];
  let io = null; // the scroll-sync observer, rebuilt on each render

  /* Do NOT fly before the map controller reports ready: a camera that is
     already moving during style load starves Mapbox's load/idle events, so
     the story dots would never be added at all. */
  let mapReady = false;
  mapCtl.ready.then(() => { mapReady = true; });

  const sectionField = roleField(tenant, 'section');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  renderChrome();

  function renderChrome() {
    const b = tenant.branding || {};
    $('mhLogo').textContent = b.logoText || tenant.name.slice(0, 2).toUpperCase();
    $('mhName').textContent = b.headerName || tenant.name;
    $('mhTag').textContent = b.tagline || b.headerSub || '';
    $('ctaBtn').textContent = tenant.cta.share;
    $('bandCta').textContent = tenant.cta.share;
    $('bandTitle').textContent = 'The next story is yours.';
    $('bandSub').textContent = b.tagline || '';
    $('mapSrc').textContent = tenant.overlays?.attribution || '';
    $('footOrg').textContent = tenant.org?.name || tenant.name;
    $('ctaBtn').addEventListener('click', () => onShare?.());
    $('bandCta').addEventListener('click', () => onShare?.());
    setFoldLabel(false);
    $('mapFold').addEventListener('click', () => setMobileMapOpen(!$('editorial').classList.contains('map-open')));
  }

  /* ── mobile fold: the companion map as a toggleable top panel ── */
  function setFoldLabel(open) {
    $('mapFold').innerHTML = `${icon('map', 14)} ${open ? 'Hide the map' : 'Follow along on the map'}`;
    $('mapFold').setAttribute('aria-expanded', String(open));
  }

  function setMobileMapOpen(open) {
    $('editorial').classList.toggle('map-open', open);
    setFoldLabel(open);
    if (open) mapCtl.resize(); // the panel was display:none while folded
  }

  /* Featured-first ordering: config-picked featured IDs are a documented
     seam, not built yet — default is the most recent story with a photo. */
  function pickHero() {
    const newest = [...stories].sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
    return newest.find(s => (s.media || []).some(m => m.kind === 'photo')) || newest[0] || null;
  }

  function quoteOf(s, max) {
    const text = storyText(tenant, s);
    return text.length > max ? text.slice(0, max).trimEnd() + '…' : text;
  }

  function sectionChip(s) {
    if (sectionField) {
      const opt = fieldOption(sectionField, s.answers?.[sectionField.id]);
      return opt ? opt.label : null;
    }
    const d = new Date(s.submitted_at);
    return isNaN(d) ? null : String(d.getFullYear());
  }

  /* Group everything but the hero into ordered sections: the section-role
     field's options in schema order (skipping empty ones), unanswered
     stories last under no divider; date-role fallback groups by year. */
  function groupSections(rest) {
    if (sectionField) {
      const groups = (sectionField.options || [])
        .map(o => ({
          label: o.label,
          items: rest.filter(s => s.answers?.[sectionField.id] === o.id),
        }))
        .filter(g => g.items.length);
      const none = rest.filter(s => !fieldOption(sectionField, s.answers?.[sectionField.id]));
      if (none.length) groups.push({ label: null, items: none });
      return groups;
    }
    const byYear = new Map();
    for (const s of [...rest].sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at))) {
      const y = String(new Date(s.submitted_at).getFullYear());
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(s);
    }
    return [...byYear.entries()].map(([label, items]) => ({ label, items }));
  }

  function renderHero(hero) {
    if (!hero) { $('hero').hidden = true; return; }
    const img = (hero.media || []).find(m => m.kind === 'photo');
    const chip = sectionChip(hero);
    $('hero').hidden = false;
    $('hero').innerHTML = `
      <div class="hero-media">${img ? `<img src="${esc(img.url)}" alt="">` : ''}</div>
      <div class="hero-scrim"></div>
      <div class="hero-body" data-story="${esc(hero.id)}" role="button" tabindex="0">
        ${chip ? `<span class="hero-chip">${esc(chip)}</span>` : ''}
        <blockquote class="hero-quote">“${esc(quoteOf(hero, QUOTE_CHARS))}”</blockquote>
        <div class="hero-byline">${esc(byline(tenant, hero))}${hero.location_label ? ` · ${esc(hero.location_label)}` : ''}</div>
      </div>`;
    const open = () => onStoryOpen?.(hero.id);
    const body = $('hero').querySelector('.hero-body');
    body.addEventListener('click', open);
    body.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  }

  function card(s) {
    const media = s.media || [];
    const img = media.find(m => m.kind === 'photo');
    const aud = media.find(m => m.kind === 'audio');
    return `<article class="st-card">
      <button class="st-card-open" data-story="${esc(s.id)}">
        ${img ? `<div class="st-card-media"><img src="${esc(img.url)}" loading="lazy" alt=""></div>` : ''}
        <div class="st-card-body">
          <p class="st-card-quote">“${esc(quoteOf(s, CARD_CHARS))}”</p>
          <div class="st-card-byline">
            <span class="st-dot" style="background:${storyColor(tenant, s)}" aria-hidden="true"></span>
            <strong>${esc(byline(tenant, s))}</strong>
            ${s.location_label ? `<span>· ${esc(s.location_label)}</span>` : ''}
            ${media.some(m => m.kind === 'video') ? `<span class="st-mi">${icon('video', 13)}</span>` : ''}
          </div>
        </div>
      </button>
      ${aud ? `<div class="st-card-audio">
        <span class="st-audio-lbl">${icon('mic', 13)} Listen</span>
        <audio controls preload="none" src="${esc(aud.url)}"></audio>
      </div>` : ''}
    </article>`;
  }

  function renderSections() {
    const hero = pickHero();
    renderHero(hero);
    const rest = stories.filter(s => s !== hero);
    const groups = groupSections(rest);

    $('sections').innerHTML = groups.length
      ? groups.map(g => `
          ${g.label ? `<div class="st-divider"><span>${esc(g.label)}</span></div>` : ''}
          ${g.items.map(card).join('')}`).join('')
      : (hero ? '' : emptyState(tenant.feed?.emptyText || 'No stories yet.'));

    $('sections').querySelectorAll('.st-card-open').forEach(el =>
      el.addEventListener('click', () => onStoryOpen?.(el.dataset.story)));

    renderRibbon();
    setupScrollSync();
  }

  /* ── gallery ribbon: every shared photo in one strip ──────────── */
  function renderRibbon() {
    const photos = stories.flatMap(s =>
      (s.media || []).filter(m => m.kind === 'photo').map(m => ({ url: m.url, story: s })));
    $('ribbon').hidden = !photos.length;
    if (!photos.length) return;
    $('ribbon').innerHTML = photos.map(p =>
      `<button class="rb-item" data-lightbox="${esc(p.url)}" aria-label="View photo from ${esc(byline(tenant, p.story))}">
        <img src="${esc(p.url)}" loading="lazy" alt="">
      </button>`).join('');
    $('ribbon').querySelectorAll('[data-lightbox]').forEach(el =>
      el.addEventListener('click', () => openLightbox(el.dataset.lightbox)));
  }

  /* ── scroll-sync: the page scrolls, the map follows ─────────────
     A card entering the reading band (upper-middle of the viewport)
     becomes the active story: its dot brightens, the rest dim, and —
     motion permitting — the map flies to it. Any failure here must
     degrade to highlight-only, then to nothing; never break reading. */
  function setupScrollSync() {
    io?.disconnect();
    io = null;
    if (mode !== 'map' || !('IntersectionObserver' in window)) return;
    const byId = new Map(stories.map(s => [s.id, s]));
    let active = null;
    try {
      io = new IntersectionObserver(entries => {
        if (!mapReady) return; // let the map finish being born first
        const vis = entries.filter(e => e.isIntersecting);
        if (!vis.length) return;
        const top = vis.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const id = top.target.dataset.story;
        if (!id || id === active) return;
        active = id;
        const s = byId.get(id);
        try {
          mapCtl.focusStory(id);
          if (!reduceMotion.matches && s && s.lat != null && s.lng != null) {
            mapCtl.flyTo(s.lat, s.lng, (tenant.map.zoom ?? 12) + 1);
          }
        } catch { /* highlight-only fallback */ }
      }, { rootMargin: '-30% 0px -55% 0px' });
      document.querySelectorAll('.hero-body[data-story], .st-card-open[data-story]')
        .forEach(el => io.observe(el));
    } catch { io = null; }
  }

  return {
    renderStories(all) { stories = all; renderSections(); },
    openStory: s => openStoryOverlay(tenant, s),
    closeStory: closeStoryOverlay,
    // The intake asked for a map tap; make sure the map is on screen.
    onPinRequest() {
      setMobileMapOpen(true);
      $('mapCol').scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'center' });
    },
    // A map dot was clicked: scroll to that story's card in the page.
    onMapStoryClick(id) {
      const card = document.querySelector(`.st-card-open[data-story="${CSS.escape(id)}"], .hero-body[data-story="${CSS.escape(id)}"]`);
      if (!card) return;
      mapCtl.focusStory(id);
      card.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'center' });
      const host = card.closest('.st-card') || card;
      host.classList.add('st-hit');
      setTimeout(() => host.classList.remove('st-hit'), 1600);
    },
    get filteredStories() { return stories; },
  };
}
