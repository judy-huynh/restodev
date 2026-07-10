/* Layout module: ATLAS — full-bleed map, side story feed, filter chips,
   layers panel, FAB + floating CTA. The default layout.

   The layout-module contract (every engine/js/layouts/<name>.js):
     export function mount(ctx) → view

   ctx (provided by app.js — the layout must not construct these itself):
     tenant        the tenant config
     mode          'map' | 'kiosk' | 'share' (URL-selected; app.js owns
                   kiosk/share behavior — layouts only arrange chrome)
     mapCtl        the app-owned map controller. A layout that exports
                   `deferMap = true` gets it uninitialized and calls
                   mapCtl.init() on first reveal (and mapCtl.resize()
                   on re-reveal); layouts never construct their own.
     onStoryOpen   (storyId) open a story's detail
     onFilterChange()        active filter changed — app re-syncs the map
     onOverlayToggle(id)     toggle a map overlay; returns new on/off state
     onShare()               open the submission flow

   view (what app.js consumes):
     renderStories(stories)  (re)render from the full approved list
     openStory(story) / closeStory()
     get filteredStories     the currently visible subset (drives map pins)
     onPinRequest()          optional: the intake asked for a map tap — a
                             layout whose map isn't full-bleed reveals it
     onMapStoryClick(id)     optional: claim map-dot clicks (Story scrolls
                             to the card); absent = dot opens the detail

   Rules: no tenant names, no fetches, no submission logic — shared modules
   own those. The shared intake partial's ids (formOverlay, chatOverlay,
   storyOverlay, pinHint, lightbox) exist in every layout's shell. */
import { createUi } from '../ui.js';
import { icon } from '../ui/icons.js';

const $ = id => document.getElementById(id);

/* Chrome copy is layout-supplied (not hardcoded in the engine templates) so
   other layouts can strike a different register — Record says "accounts on
   the record", Atlas says "stories". app.js applies the shared-partial
   strings (pinHint, backToMap); createUi applies the rest. */
export const strings = {
  fabLabel: 'Stories',
  allChip: 'All',
  noun: ['story', 'stories'],
  pinHint: 'Tap the map to pin your story',
  backToMap: '← Back to Map',
  welcomeHint: 'Tap a dot to read a story — or add yours in about two minutes',
};

export function mount({ tenant, mode, onStoryOpen, onFilterChange, onOverlayToggle, onShare }) {
  const ui = createUi(tenant, { onStoryOpen, onFilterChange, onOverlayToggle }, strings);
  ui.renderChrome();

  // this layout's own chrome iconography
  $('fabBtn').innerHTML = `${icon('chat')} ${strings.fabLabel} <span class="fab-n" id="fabN">0</span>`;
  document.querySelector('.view-btn[data-view="list"]').innerHTML = icon('list', 15);
  document.querySelector('.view-btn[data-view="gallery"]').innerHTML = icon('grid', 15);

  // chrome events (this layout's own DOM)
  $('ctaBtn').addEventListener('click', () => onShare?.());
  $('fabBtn').addEventListener('click', () => $('side').classList.toggle('open'));
  $('closeSide').addEventListener('click', () => $('side').classList.remove('open'));
  document.querySelectorAll('.view-btn').forEach(b =>
    b.addEventListener('click', () => ui.setSideView(b.dataset.view)));

  // desktop: the feed presents itself once the visitor has their bearings
  if (mode === 'map' && window.innerWidth >= 768) {
    setTimeout(() => $('side').classList.add('open'), 500);
  }

  return ui;
}
