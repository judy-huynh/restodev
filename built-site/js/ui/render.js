/* Shared story renderers — layout-agnostic, DOM-free.
   Every layout renders stories through these functions so UGC escaping and
   consent-derived bylines live in exactly one place. Nothing here touches
   document or assumes an element id: callers pass data in, HTML comes out. */
import { roleField, fieldOption, storyColor, storyGradient, storyText } from '../config.js';
import { icon } from './icons.js';

export const esc = s =>
  String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* The public byline is whatever the consent trigger let through — never the
   contact name. Layouts must not compose bylines any other way. */
export function byline(tenant, story) {
  return story.display_name || tenant.consent?.anonymousLabel || 'Anonymous';
}

export function emptyState(text) {
  return `<div style="padding:24px;text-align:center;color:var(--muted);font-size:.8rem">${esc(text)}</div>`;
}

/* Shorten UGC for a tile or row without chopping mid-word: cut at the last
   word break past 60% of the budget, drop a dangling comma/period, add …. */
export function excerpt(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const brk = cut.lastIndexOf(' ');
  return (brk > max * 0.6 ? cut.slice(0, brk) : cut).trimEnd().replace(/[,;:.!?]+$/, '') + '…';
}

/* One story card (the feed unit). Clicks are the caller's job: the card
   carries data-story, and any [data-lightbox] child opens the image. */
export function storyCard(tenant, s) {
  const filterField = roleField(tenant, 'filter');
  const media = s.media || [];
  const imgs = media.filter(m => m.kind === 'photo');
  const catOpt = fieldOption(filterField, s.answers?.[filterField?.id]);
  const hero = imgs.length
    ? `<div class="scard-hero" data-lightbox="${esc(imgs[0].url)}">
        <img src="${esc(imgs[0].url)}" loading="lazy" alt="">
        ${imgs.length > 1 ? `<span class="scard-hero-count">+${imgs.length - 1}</span>` : ''}
      </div>` : '';
  return `<div class="scard" data-story="${esc(s.id)}">
    ${hero}
    <div class="scard-top">
      <div class="scard-dot" style="background:${storyColor(tenant, s)}"></div>
      <div class="scard-who">${esc(byline(tenant, s))}</div>
      <div class="scard-hood">${esc(s.location_label || '')}</div>
    </div>
    <div class="scard-txt">${esc(storyText(tenant, s))}</div>
    <div class="scard-footer">
      ${catOpt ? `<span class="scard-cat">${catOpt.emoji || ''} ${esc(catOpt.label)}</span>` : ''}
      <div class="scard-media">
        ${media.some(m => m.kind === 'video') ? `<span class="scard-cat">${icon('video')} Video</span>` : ''}
        ${media.some(m => m.kind === 'audio') ? `<span class="scard-cat">${icon('mic')} Audio</span>` : ''}
      </div>
      <div class="scard-date">${new Date(s.submitted_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
    </div>
  </div>`;
}

/* One gallery tile for a single media item ({ ...media, story }).
   Tiles act as buttons (they open the story), so they carry the role and
   are focusable; callers bind click AND Enter/Space. */
export function galleryItem(tenant, item) {
  const attrs = `data-story="${esc(item.story.id)}" role="button" tabindex="0" aria-label="Open story from ${esc(byline(tenant, item.story))}"`;
  const overlay = `<div class="gal-overlay">
      <span class="gal-name">${esc(byline(tenant, item.story))}</span>
      <span class="gal-hood">${esc(item.story.location_label || '')}</span>
    </div>`;
  if (item.kind === 'photo') {
    return `<div class="gal-item" ${attrs}>
      <img src="${esc(item.url)}" loading="lazy" alt="">${overlay}</div>`;
  }
  if (item.kind === 'video') {
    return `<div class="gal-item gal-vid" ${attrs}>
      <video src="${esc(item.url)}" muted preload="metadata"></video>
      <div class="gal-play">▶</div>${overlay}</div>`;
  }
  return `<div class="gal-item gal-aud" ${attrs}>
    <div class="gal-aud-ico">${icon('mic', 30)}<span class="gal-aud-lbl">Voice note</span></div>${overlay}</div>`;
}

/* The story detail (popup body). Returns pieces, not a whole overlay, so
   each layout can host it in its own shell: { headStyle, headHtml, bodyHtml }.
   Callers bind [data-lightbox] clicks after insertion. */
export function storyDetail(tenant, s) {
  const colorField = roleField(tenant, 'color');
  const filterField = roleField(tenant, 'filter');
  const [g1, g2] = storyGradient(tenant, s);
  const media = s.media || [];
  const imgs = media.filter(m => m.kind === 'photo');
  const vids = media.filter(m => m.kind === 'video');
  const auds = media.filter(m => m.kind === 'audio');
  const typeOpt = fieldOption(colorField, s.answers?.[colorField?.id]);
  const catOpt = fieldOption(filterField, s.answers?.[filterField?.id]);
  const dt = new Date(s.submitted_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

  const headHtml = `
    <div class="sp-type">${typeOpt ? `${typeOpt.emoji || ''} ${esc(typeOpt.label)}` : ''}</div>
    <div class="sp-name">${esc(byline(tenant, s))}</div>
    <div class="sp-meta">
      ${s.location_label ? `<span>${esc(s.location_label)}</span><span>·</span>` : ''}
      <span>${dt}</span>
      ${catOpt ? `<span class="sp-cat-badge">${catOpt.emoji || ''} ${esc(catOpt.label)}</span>` : ''}
    </div>`;

  let bodyHtml = `<p class="sp-text">${esc(storyText(tenant, s)).replace(/\n/g, '<br>')}</p>`;

  /* Extra config-defined answers beyond the roles (custom questions). */
  const roleIds = new Set(Object.values(tenant.storySchema.roles || {}));
  for (const f of tenant.storySchema.fields) {
    if (roleIds.has(f.id)) continue;
    const v = s.answers?.[f.id];
    if (!v) continue;
    const opt = fieldOption(f, v);
    bodyHtml += `<div class="sp-section-title">${esc(f.label)}</div>
      <p class="sp-text" style="font-size:.8rem">${esc(opt ? opt.label : v)}</p>`;
  }

  if (imgs.length) {
    bodyHtml += `<div class="sp-section-title">${icon('camera')} Photos (${imgs.length})</div>
      <div class="sp-gallery">${imgs.map(m =>
        `<img class="sp-photo" src="${esc(m.url)}" data-lightbox="${esc(m.url)}" loading="lazy" alt="">`).join('')}</div>`;
  }
  if (vids.length) {
    bodyHtml += `<div class="sp-section-title">${icon('video')} Video</div>` +
      vids.map(m => `<video class="sp-video" controls playsinline><source src="${esc(m.url)}"></video>`).join('');
  }
  if (auds.length) {
    bodyHtml += `<div class="sp-section-title">${icon('mic')} Voice Recording</div>` +
      auds.map(m => `<div class="sp-audio-wrap">
        <div class="sp-audio-label">${icon('mic')} Audio story</div>
        <audio class="sp-audio" controls src="${esc(m.url)}"></audio></div>`).join('');
  }

  return { headStyle: `background:linear-gradient(135deg,${g1},${g2})`, headHtml, bodyHtml };
}
