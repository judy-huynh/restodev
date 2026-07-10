/* Layout module: GALLERY — the photo wall. Media leads: a masonry wall of
   every shared photo/video/voice note, text-only stories as quote tiles so
   they aren't invisible, and a Wall/Map toggle (the map is the secondary
   view — standard dots, same data).

   Same contract as every layout (documented in layouts/atlas.js):
   mount(ctx) → view. Tiles come from the shared galleryItem() renderer;
   tile opens go through the shared story detail.

   layoutOptions.gallery (all optional, fail-soft):
     mapLabel    the map view's toggle label ("Constellation") — default "Map"
     mapCaption  a line over the map view ("A constellation of everyone…")
     sparkCta    the tap hint on spark tiles — default "Tap to add yours"

   When the tenant ships a prompts pack, the wall itself asks: spark tiles
   (one prompt each, tap opens the intake) are woven in between the media
   tiles, so the invitation lives where everyone is already looking. */
import { storyGradient, storyText, promptPack } from '../config.js';
import { esc, byline, galleryItem, emptyState, excerpt } from '../ui/render.js';
import { openStoryOverlay, closeStoryOverlay } from '../ui/detail.js';
import { icon } from '../ui/icons.js';

const $ = id => document.getElementById(id);

export const strings = {
  pinHint: 'Tap the map to pin your story',
  backToMap: '← Back to the wall',
  // no welcomeHint: a wall of faces and places explains itself
};

/* The wall is the primary view: no basemap loads until someone switches
   to the Map view (or the intake asks for a pin). */
export const deferMap = true;

/* A photo wall's natural intake starts with the photo. Tenants can still
   override with form.stepOrder in config. */
export const stepOrder = ['media', 'story', 'location', 'about'];

const QUOTE_CHARS = 220;
const SPARK_EVERY = 5; // one spark tile per this many wall tiles

export function mount({ tenant, mode, mapCtl, onStoryOpen, onShare }) {
  let stories = [];
  let view = 'wall';

  const opts = tenant.layoutOptions?.gallery || {};
  const prompts = promptPack(tenant);

  renderChrome();

  function renderChrome() {
    const b = tenant.branding || {};
    $('gwLogo').textContent = b.logoText || tenant.name.slice(0, 2).toUpperCase();
    $('gwName').textContent = b.headerName || tenant.name;
    $('gwSub').textContent = b.headerSub || b.tagline || '';
    $('ctaBtn').textContent = tenant.cta.share;
    $('ctaBtn').addEventListener('click', () => onShare?.());
    $('mapSrc').textContent = tenant.overlays?.attribution || '';
    $('footOrg').textContent = tenant.org?.name || tenant.name;
    $('viewWall').innerHTML = `${icon('grid', 14)} Wall`;
    $('viewMap').innerHTML = `${icon('map', 14)} ${esc(opts.mapLabel || 'Map')}`;
    if (opts.mapCaption) {
      $('mapCap').textContent = opts.mapCaption;
      $('mapCap').hidden = false;
    }
    document.querySelectorAll('.gw-view').forEach(btn =>
      btn.addEventListener('click', () => setView(btn.dataset.view)));
  }

  /* ── wall ⇄ map (no reload; the map lazy-inits on first look) ── */
  function setView(next) {
    view = next;
    $('wallWrap').hidden = view !== 'wall';
    $('gwMap').hidden = view !== 'map';
    document.querySelectorAll('.gw-view').forEach(btn => {
      const on = btn.dataset.view === view;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-selected', String(on));
    });
    if (view === 'map') {
      if (mapCtl.map) mapCtl.resize();
      else mapCtl.init();
    }
  }

  function quoteTile(s) {
    const [g1, g2] = storyGradient(tenant, s);
    const quote = excerpt(storyText(tenant, s), QUOTE_CHARS);
    return `<div class="quote-tile" data-story="${esc(s.id)}" role="button" tabindex="0"
      aria-label="Open story from ${esc(byline(tenant, s))}"
      style="background:linear-gradient(135deg,${g1},${g2})">
      <p class="qt-text">“${esc(quote)}”</p>
      <span class="qt-who">${esc(byline(tenant, s))}${s.location_label ? ` · ${esc(s.location_label)}` : ''}</span>
    </div>`;
  }

  /* A spark tile: one prompt from the pack, woven into the wall. Tapping it
     opens the intake — the prompt is the invitation. */
  function sparkTile(p) {
    return `<div class="spark-tile" role="button" tabindex="0"
      aria-label="${esc(p.text)} — ${esc(opts.sparkCta || 'add yours')}">
      <span class="sp-label">${esc(tenant.kiosk?.promptLabel || 'Need a spark?')}</span>
      ${p.emoji ? `<span class="sp-emoji" aria-hidden="true">${esc(p.emoji)}</span>` : ''}
      <p class="sp-text">${esc(p.text)}</p>
      <span class="sp-cta">${esc(opts.sparkCta || 'Tap to add yours')}</span>
    </div>`;
  }

  function renderWall() {
    // One tile per media item; a story with no media becomes a quote tile.
    // Newest first — the wall should feel alive during an event.
    const sorted = [...stories].sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
    const tiles = sorted.flatMap(s => {
      const media = s.media || [];
      return media.length
        ? media.map(m => galleryItem(tenant, { ...m, story: s }))
        : [quoteTile(s)];
    });

    // Weave the fun prompts in between the memories (at least one whenever
    // the wall has anything at all), cycling through the pack.
    if (prompts.length && tiles.length) {
      const woven = [];
      let si = 0;
      tiles.forEach((t, i) => {
        woven.push(t);
        if ((i + 1) % SPARK_EVERY === 0) woven.push(sparkTile(prompts[si++ % prompts.length]));
      });
      if (si === 0) woven.push(sparkTile(prompts[0]));
      tiles.length = 0;
      tiles.push(...woven);
    }

    $('wall').innerHTML = tiles.join('') ||
      emptyState(tenant.feed?.emptyText || 'Nothing on the wall yet — add the first one.');
    $('wall').querySelectorAll('[data-story]').forEach(el => {
      el.addEventListener('click', () => onStoryOpen?.(el.dataset.story));
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onStoryOpen?.(el.dataset.story); }
      });
    });
    $('wall').querySelectorAll('.spark-tile').forEach(el => {
      el.addEventListener('click', () => onShare?.());
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onShare?.(); }
      });
    });
  }

  return {
    renderStories(all) { stories = all; renderWall(); },
    openStory: s => openStoryOverlay(tenant, s),
    closeStory: closeStoryOverlay,
    // The intake asked for a map tap; show the map view for it.
    onPinRequest() {
      setView('map');
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      $('gwMap').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    },
    get filteredStories() { return stories; },
  };
}
