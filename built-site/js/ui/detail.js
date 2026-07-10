/* Shared story-detail overlay + lightbox glue. The overlay DOM lives in the
   shared intake partial (storyOverlay/spHead/spBody, lightbox/lbImg), so the
   open/close mechanics are identical in every layout; each layout only
   restyles the shell in its CSS. Story HTML comes from ui/render.js —
   user-generated content is escaped there, in one place. */
import { storyDetail } from './render.js';

const $ = id => document.getElementById(id);

export function openLightbox(src) {
  $('lbImg').src = src;
  $('lightbox').classList.add('open');
}

export function openStoryOverlay(tenant, s) {
  const { headStyle, headHtml, bodyHtml } = storyDetail(tenant, s);
  $('spHead').style.cssText = headStyle;
  $('spHead').innerHTML = headHtml;
  $('spBody').innerHTML = bodyHtml;
  $('spBody').querySelectorAll('[data-lightbox]').forEach(el =>
    el.addEventListener('click', () => openLightbox(el.dataset.lightbox)));
  $('storyOverlay').classList.add('open');
}

export function closeStoryOverlay() {
  $('storyOverlay').classList.remove('open');
  $('spBody').innerHTML = ''; // stop any video/audio still playing
}
