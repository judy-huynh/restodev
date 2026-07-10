/* Public app bootstrap: config → theme → map → data → UI.

   One page, three operating modes, selected by URL — never by engine forks:
     (default)          the public map: explore stories, submit via the CTA
     ?mode=kiosk        attended event mode: attract screen, full-screen intake,
                        idle-timeout wipe, nothing persists between participants
     ?mode=share&c=…    remote link a resident opens on their own phone:
                        conversational pacing, resumable draft, campaign-tagged
   The questions asked are identical in every mode (they come from the tenant
   config); only the chrome and pacing change. */
import { loadConfig, applyTheme, promptPack } from './config.js';
import { createApi } from './data.js';
import { createMapController } from './map.js';
import { createForm } from './form.js';
import { createChatIntake } from './intake-chat.js';
import { esc } from './ui.js';
import { icon } from './ui/icons.js';

const $ = id => document.getElementById(id);

const params = new URLSearchParams(location.search);
const MODE = ['kiosk', 'share'].includes(params.get('mode')) ? params.get('mode') : 'map';
const CAMPAIGN = (params.get('c') || params.get('campaign') || '').slice(0, 64) || null;

/* Drafts exist ONLY in share mode — the resident's own device. Kiosk mode
   never touches storage: one participant's words must not survive to the
   next pair of hands. */
function makeDraftStore(tenant) {
  if (MODE !== 'share') return null;
  const key = `gt-draft-${tenant.slug}-${CAMPAIGN || 'default'}`;
  const MAX_AGE = 7 * 24 * 3600 * 1000;
  return {
    load() {
      try {
        const d = JSON.parse(localStorage.getItem(key) || 'null');
        if (!d || Date.now() - d.ts > MAX_AGE) { localStorage.removeItem(key); return null; }
        return d.answers && Object.keys(d.answers).length ? d.answers : null;
      } catch { return null; }
    },
    save(answers) {
      try { localStorage.setItem(key, JSON.stringify({ answers, ts: Date.now() })); } catch { /* storage full/blocked — resume is best-effort */ }
    },
    clear() { try { localStorage.removeItem(key); } catch { /* ignore */ } },
  };
}

async function main() {
  const { platform, tenant } = await loadConfig();
  applyTheme(tenant);
  document.body.dataset.mode = MODE;

  const api = createApi(platform, tenant);
  let stories = [];
  let pinMode = false;

  // The layout module owns the page's chrome and arrangement; app.js owns
  // config, data, the map controller, submission, and the operating modes.
  // `layout` is validated at build time — an unknown value never ships.
  // Imported before the map controller so a layout that demotes the map
  // (deferMap) can keep the basemap from loading until it's asked for.
  const layoutName = tenant.layout || 'atlas';
  const layoutModule = await import(`./layouts/${layoutName}.js`);
  const { mount, strings: layoutStrings = {}, deferMap = false } = layoutModule;

  const mapCtl = createMapController(tenant, {
    onStoryClick: id => {
      if (pinMode) return;
      if (MODE === 'kiosk') return; // kiosk is single-purpose: the map is a pin canvas
      // A layout may claim dot clicks (Story scrolls to the card in the page
      // instead of popping the detail); default remains open-the-story.
      if (ui.onMapStoryClick) { ui.onMapStoryClick(id); return; }
      const s = stories.find(x => x.id === id);
      if (s) openStory(s);
    },
    onMapClick: (lat, lng) => {
      if (!pinMode) return;
      pinMode = false;
      mapCtl.dropPin(lat, lng);
      form.setPinLocation(lat, lng);
    },
  }, { defer: deferMap });

  // Submission renderer: the stepped sheet by default, the conversational
  // intake when the tenant opts in — and always conversational for share
  // links, which are paced for someone alone on their phone.
  const conversational = tenant.form?.intakeMode === 'conversational' || MODE === 'share';
  const makeIntake = conversational ? createChatIntake : createForm;
  const form = makeIntake(tenant, {
    api,
    platform,
    mode: MODE,
    source: { mode: MODE, campaign: CAMPAIGN },
    // Stepped-form order: tenant config wins, else the layout's default
    // (Gallery leads with media). Conversational intake ignores this —
    // its pacing stays schema-driven.
    stepOrder: tenant.form?.stepOrder || layoutModule.stepOrder,
    draft: makeDraftStore(tenant),
    // Layouts where the map isn't full-bleed need to bring it into view
    // before a tap can land on it — hence the optional view hook.
    onRequestPin: () => { pinMode = true; ui.onPinRequest?.(); },
    onSubmit: payload => api.submitStory(payload),
    onDone: () => {
      if (MODE === 'kiosk') { kiosk?.reset(); return; }
      const { lat, lng } = form.pending;
      if (lat != null) mapCtl.flyTo(lat, lng);
      mapCtl.clearPin();
    },
    onClose: () => {
      pinMode = false;
      mapCtl.clearPin();
      if (MODE === 'kiosk') kiosk?.toAttract();
    },
  });

  function openStory(s) {
    ui.openStory(s);
    if (s.lat != null && s.lng != null) mapCtl.flyTo(s.lat, s.lng);
  }

  const ui = mount({
    tenant,
    mode: MODE,
    mapCtl,
    onStoryOpen: id => {
      const s = stories.find(x => x.id === id);
      if (s) openStory(s);
    },
    onFilterChange: () => mapCtl.setStories(ui.filteredStories),
    onOverlayToggle: id => mapCtl.toggleOverlay(id),
    onShare: () => form.open(),
  });

  // shared intake/story-detail partial: layout-supplied wording + events
  // (these ids exist in every layout's shell)
  $('pinHint').innerHTML = `${icon('pin')} ${esc(layoutStrings.pinHint || 'Tap the map to pin your story')}`;
  $('spClose').textContent = layoutStrings.backToMap || '← Back';
  $('storyOverlay').addEventListener('click', e => { if (e.target.id === 'storyOverlay') ui.closeStory(); });
  $('spClose').addEventListener('click', () => ui.closeStory());
  $('formOverlay')?.addEventListener('click', e => { if (e.target.id === 'formOverlay') form.close(); });
  $('chatClose')?.addEventListener('click', () => form.close());
  $('lightbox').addEventListener('click', () => $('lightbox').classList.remove('open'));

  const kiosk = MODE === 'kiosk' ? setupKiosk(tenant, form, {
    // The idle-wipe path bypasses onClose, so it must clear the map itself:
    // a dropped pin (a sensitive location) and a stuck pinMode must never
    // survive to the next participant.
    clearMap: () => { pinMode = false; mapCtl.clearPin(); },
  }) : null;
  if (MODE === 'share') form.open();
  if (MODE === 'map') showWelcomeHint(layoutStrings);

  // The feed must not wait on basemap tiles: render stories as soon as the
  // data arrives, and drop pins whenever the map finishes loading.
  try {
    stories = await api.fetchApprovedStories();
  } catch (e) {
    console.error('could not load stories:', e);
    stories = [];
  }
  ui.renderStories(stories);
  mapCtl.ready.then(() => mapCtl.setStories(ui.filteredStories));
}

/* ── kiosk mode ──────────────────────────────────────────────────
   An iPad on a folding table. Rules: full-screen attract loop between
   participants; large targets; a hard privacy wipe (state AND DOM) on
   every reset; an idle countdown so a walk-away never leaves someone's
   story on screen for the next person. */
function setupKiosk(tenant, form, { clearMap } = {}) {
  const k = tenant.kiosk || {};
  const prompts = promptPack(tenant);
  const attract = document.createElement('div');
  attract.className = 'kiosk-attract show';
  attract.id = 'kioskAttract';
  attract.innerHTML = `
    <div class="ka-inner">
      <div class="ka-logo">${esc(tenant.branding?.logoText || tenant.name.slice(0, 2).toUpperCase())}</div>
      <h1 class="ka-headline">${esc(k.headline || tenant.cta.share.replace(/^[^\p{L}\p{N}]+/u, ''))}</h1>
      <p class="ka-sub">${esc(k.sub || 'Your story helps make the case for change. It takes about two minutes, and you choose how your name appears, or whether it appears at all.')}</p>
      ${prompts.length ? `<div class="ka-prompts" id="kaPrompts" aria-live="off">
        <span class="ka-spark">${esc(k.promptLabel || 'Not sure where to start?')}</span>
        <span class="ka-prompt" id="kaPrompt">${esc((prompts[0].emoji ? prompts[0].emoji + '  ' : '') + prompts[0].text)}</span>
      </div>` : ''}
      <button class="ka-start" id="kaStart">${esc(k.start || 'Tap to begin')}</button>
      <p class="ka-org">${esc(tenant.org?.name || tenant.name)}</p>
    </div>`;
  document.body.appendChild(attract);

  // Rotate the fun prompts on the attract screen. Reduced-motion users get a
  // single static prompt (no swapping). The timer is cleared with the kiosk.
  let promptTimer = null;
  if (prompts.length > 1 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    let pi = 0;
    promptTimer = setInterval(() => {
      pi = (pi + 1) % prompts.length;
      const el = $('kaPrompt');
      if (!el) return;
      el.style.opacity = '0';
      setTimeout(() => {
        el.textContent = (prompts[pi].emoji ? prompts[pi].emoji + '  ' : '') + prompts[pi].text;
        el.style.opacity = '1';
      }, 320);
    }, 3600);
  }

  const warn = document.createElement('div');
  warn.className = 'kiosk-warn';
  warn.id = 'kioskWarn';
  warn.innerHTML = `
    <div class="kw-card">
      <h2>Still there?</h2>
      <p>To protect your privacy, this screen clears itself when no one is using it.</p>
      <div class="kw-count" id="kwCount">15</div>
      <button class="kw-keep" id="kwKeep">I’m still here</button>
    </div>`;
  document.body.appendChild(warn);

  const IDLE_MS = 75_000, WARN_S = 15;
  let idleTimer = null, warnTimer = null, warnLeft = WARN_S, active = false;

  function toAttract() {
    active = false;
    clearTimeout(idleTimer); clearInterval(warnTimer);
    warn.classList.remove('show');
    form.wipe();  // privacy: state AND rendered DOM from the last participant
    clearMap?.(); // and the dropped pin + pinMode, which wipe() can't reach
    attract.classList.add('show');
  }

  function reset() { toAttract(); }

  function start() {
    attract.classList.remove('show');
    active = true;
    armIdle();
    form.open();
  }

  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(showWarn, IDLE_MS);
  }

  function showWarn() {
    if (!active) return;
    warnLeft = WARN_S;
    $('kwCount').textContent = warnLeft;
    warn.classList.add('show');
    warnTimer = setInterval(() => {
      warnLeft--;
      $('kwCount').textContent = warnLeft;
      if (warnLeft <= 0) toAttract();
    }, 1000);
  }

  function keepGoing() {
    clearInterval(warnTimer);
    warn.classList.remove('show');
    armIdle();
  }

  $('kaStart').addEventListener('click', start);
  attract.addEventListener('click', start);
  $('kwKeep').addEventListener('click', e => { e.stopPropagation(); keepGoing(); });
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
    document.addEventListener(ev, () => {
      if (!active || warn.classList.contains('show')) return;
      armIdle();
    }, { passive: true }));

  return { toAttract, reset };
}

/* ── first-visit hint (map mode) ─────────────────────────────────
   The 90-second rule starts here: a stranger landing on the map should
   instantly know there are two things to do — read, or add. */
function showWelcomeHint(layoutStrings) {
  if (!layoutStrings.welcomeHint) return; // a layout may not want one
  try {
    if (sessionStorage.getItem('gt-hint-seen')) return;
    sessionStorage.setItem('gt-hint-seen', '1');
  } catch { /* private browsing — show it anyway */ }
  const hint = document.createElement('div');
  hint.className = 'welcome-hint';
  hint.innerHTML = `<span>${esc(layoutStrings.welcomeHint)}</span><button aria-label="Dismiss">✕</button>`;
  document.body.appendChild(hint);
  const dismiss = () => { hint.classList.add('bye'); setTimeout(() => hint.remove(), 400); };
  hint.querySelector('button').addEventListener('click', dismiss);
  setTimeout(() => hint.classList.add('show'), 900);
  setTimeout(dismiss, 10_000);
  document.getElementById('ctaBtn').addEventListener('click', dismiss, { once: true });
}

main().catch(e => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend',
    `<div style="position:fixed;inset:auto 16px 16px 16px;background:#fff;border:2px solid #D63B3B;border-radius:10px;padding:14px;z-index:99;font-family:sans-serif;font-size:.85rem">
      This site failed to start: ${String(e.message).replace(/[<>]/g, '')}</div>`);
});
