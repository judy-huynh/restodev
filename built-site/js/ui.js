/* Public UI chrome for the current layout: header, overlay panel, legend,
   side-panel feed/gallery, story popup shell.
   All copy, colors, and taxonomies come from the tenant config.
   Story HTML itself comes from the shared renderers in ui/render.js —
   user-generated content is escaped there, in one place. */
import { roleField } from './config.js';
import { esc, storyCard, galleryItem, emptyState } from './ui/render.js';
import { openStoryOverlay, closeStoryOverlay, openLightbox } from './ui/detail.js';
import { icon } from './ui/icons.js';

export { esc };

const $ = id => document.getElementById(id);

export function createUi(tenant, { onStoryOpen, onFilterChange, onOverlayToggle }, strings = {}) {
  const S = { allChip: 'All', noun: ['story', 'stories'], ...strings };
  let activeFilter = 'all';
  let stories = [];
  let sideView = 'list';

  const filterField = roleField(tenant, 'filter');
  const colorField = roleField(tenant, 'color');

  // ── static chrome ─────────────────────────────────────────────
  function renderChrome() {
    const b = tenant.branding || {};
    $('logoText').textContent = b.logoText || tenant.name.slice(0, 2).toUpperCase();
    $('hdrName').textContent = b.headerName || tenant.name;
    $('hdrSub').textContent = b.headerSub || '';
    $('hdrOrg').innerHTML = tenant.org?.name ? `<strong>${esc(tenant.org.name)}</strong>` : '';
    $('sideTitle').textContent = tenant.feed?.title || 'Community Stories';
    $('ctaBtn').textContent = tenant.cta.share;

    // overlay panel: hidden entirely when a tenant has no overlays
    const layers = tenant.overlays?.layers || [];
    const panel = $('layersPanel');
    if (!layers.length && !colorField?.options?.length) {
      panel.style.display = 'none';
    } else {
      panel.querySelector('.l-title').textContent = tenant.overlays?.title || 'Map Layers';
      $('layerItems').innerHTML = layers.map(l => `
        <div class="l-item ${l.defaultOn ? 'on' : ''}" data-overlay="${esc(l.id)}">
          <div class="l-dot" style="background:${esc(l.color)}"></div>
          <div class="l-label">${esc(l.label)}</div>
          ${l.badge ? `<div class="l-badge">${esc(l.badge)}</div>` : ''}
          ${l.caption ? `<div class="l-cap">${esc(l.caption)}</div>` : ''}
        </div>`).join('');
      $('layerItems').querySelectorAll('.l-item').forEach(el => {
        el.addEventListener('click', () => {
          const on = onOverlayToggle?.(el.dataset.overlay);
          el.classList.toggle('on', !!on);
        });
      });
      $('lSrc').textContent = tenant.overlays?.attribution || '';
      // legend: the color-role field's options
      $('legendItems').innerHTML = (colorField?.options || []).map(o => `
        <div class="leg"><div class="leg-dot" style="background:${esc(o.color)}"></div>
        <div class="leg-lbl">${esc(o.label)}</div></div>`).join('');
      const legTitle = panel.querySelector('.l-sep .l-title');
      if (legTitle) legTitle.textContent = colorField?.legendTitle || colorField?.label || 'Story Types';
      // mobile: the panel starts folded to its title; tapping unfolds it
      panel.classList.add('collapsed');
      panel.querySelector('.l-title').addEventListener('click', () => panel.classList.toggle('collapsed'));
    }
    renderFilters();
  }

  function renderFilters() {
    const opts = filterField?.options || [];
    if (!opts.length) { $('catRow').style.display = 'none'; return; }
    const countFor = id => stories.filter(s => s.answers?.[filterField.id] === id).length;
    $('catRow').innerHTML =
      `<button class="cat-chip ${activeFilter === 'all' ? 'on' : ''}" data-f="all">${icon('map')} ${esc(S.allChip)}${stories.length ? ` <span class="chip-n">${stories.length}</span>` : ''}</button>` +
      opts.map(o => {
        const n = countFor(o.id);
        return `
        <button class="cat-chip ${activeFilter === o.id ? 'on' : ''}" data-f="${esc(o.id)}">
          ${o.emoji || ''} ${esc(o.label)}${n ? ` <span class="chip-n">${n}</span>` : ''}</button>`;
      }).join('');
    $('catRow').querySelectorAll('.cat-chip').forEach(el =>
      el.addEventListener('click', () => {
        activeFilter = el.dataset.f;
        renderFilters();
        renderStories(stories);
        onFilterChange?.(activeFilter);
      }));
  }

  // ── stories ───────────────────────────────────────────────────
  function filtered() {
    if (activeFilter === 'all' || !filterField) return stories;
    return stories.filter(s => s.answers?.[filterField.id] === activeFilter);
  }

  function renderStories(all) {
    stories = all;
    const list = filtered();
    const n = stories.length;
    $('badge').innerHTML = `${icon('pin')} ${n} ${esc(n === 1 ? S.noun[0] : S.noun[1])} ${esc(tenant.branding?.storiesBadgeArea || '')}`;
    $('fabN').textContent = n;
    $('sideSub').textContent = `${list.length} of ${n} ${n === 1 ? S.noun[0] : S.noun[1]}`;
    renderFilters(); // chips carry live per-category counts
    renderFeed(list);
    renderGallery(list);
    return list;
  }

  function renderFeed(list) {
    $('feed').innerHTML = list.map(s => storyCard(tenant, s)).join('') ||
      emptyState(tenant.feed?.emptyText || 'No stories yet in this view.');

    $('feed').querySelectorAll('.scard').forEach(el =>
      el.addEventListener('click', e => {
        const lb = e.target.closest('[data-lightbox]');
        if (lb) { openLightbox(lb.dataset.lightbox); e.stopPropagation(); return; }
        onStoryOpen?.(el.dataset.story);
      }));
  }

  function renderGallery(list) {
    const items = list.flatMap(s => (s.media || []).map(m => ({ ...m, story: s })));
    $('gallery').innerHTML = items.length
      ? items.map(item => galleryItem(tenant, item)).join('')
      : emptyState('No photos or media shared yet.');
    $('gallery').querySelectorAll('.gal-item').forEach(el => {
      el.addEventListener('click', () => onStoryOpen?.(el.dataset.story));
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onStoryOpen?.(el.dataset.story); }
      });
    });
  }

  // ── story popup (shared overlay glue in ui/detail.js) ──────────
  function openStory(s) { openStoryOverlay(tenant, s); }
  function closeStory() { closeStoryOverlay(); }

  function setSideView(view) {
    sideView = view;
    $('feed').style.display = view === 'list' ? 'block' : 'none';
    $('gallery').style.display = view === 'gallery' ? 'grid' : 'none';
    document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  }

  return {
    renderChrome, renderStories, openStory, closeStory, setSideView,
    get activeFilter() { return activeFilter; },
    get filteredStories() { return filtered(); },
  };
}
