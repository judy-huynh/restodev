/* Layout module: RECORD — the case and the living atlas, combined. An
   advocacy masthead (headline, stat tiles, evidence export) sits over a
   full-bleed map where every account is a place you can stand; the ledger
   below is the evidence itself, row by row. Zero emoji in the chrome.

   Same contract as every layout (documented in layouts/atlas.js):
   mount(ctx) → view. Story HTML comes from the shared renderers; the
   story detail opens through the shared overlay glue in ui/detail.js.

   layoutOptions.record:
     countNoun   the record's noun ("stories") — [singular, plural] or plural
     countSuffix the count line's phrase after the noun ("shared so far");
                 defaults to "on the record"
     case        the advocacy masthead, all optional and fail-soft:
       eyebrow     kicker above the headline (org name appends automatically)
       headline    the case being made, in one line
       stats       tiles: { metric: "count" } renders the live total;
                   { value, label, accent? } is the tenant's own claim —
                   accent marks the gut-punch number
       export      label for the evidence download (CSV of the filtered
                   ledger); omit to hide the control */
import { fieldOption, storyText, storyColor } from '../config.js';
import { esc, byline, emptyState, excerpt } from '../ui/render.js';
import { openStoryOverlay, closeStoryOverlay } from '../ui/detail.js';
import { icon } from '../ui/icons.js';

const $ = id => document.getElementById(id);

export const strings = {
  pinHint: 'Tap the map to mark the place',
  backToMap: '← Back to the record',
  // no welcomeHint: the record does not greet, it holds
};

/* The map is the page here: it initializes with the layout. */
export const deferMap = false;

const EXCERPT_CHARS = 200;

export function mount({ tenant, mode, mapCtl, onStoryOpen, onFilterChange, onShare }) {
  let stories = [];
  const active = {}; // fieldId → selected option id (absent = all)

  const opts = tenant.layoutOptions?.record || {};
  const kase = opts.case || {};

  /* The count line's noun sets this layout's entire register ("47 accounts
     on the record"). Accepts [singular, plural] or a plural string
     (singular = trailing 's' dropped). */
  const rawNoun = opts.countNoun;
  const noun = Array.isArray(rawNoun) ? rawNoun
    : rawNoun ? [rawNoun.replace(/s$/, ''), rawNoun]
    : ['story', 'stories'];

  /* Every choice/select field with options becomes a filter control that
     drives the map and the ledger together — a tenant's own questions
     define its record's axes, no config needed. Row chips come from
     `select` fields only (year-style facts); `choice` fields carry the
     color/filter roles and already read as categories. */
  const filterFields = (tenant.storySchema.fields || [])
    .filter(f => ['choice', 'select'].includes(f.kind) && f.options?.length);
  const chipFields = filterFields.filter(f => f.kind === 'select');

  renderChrome();

  function renderChrome() {
    const b = tenant.branding || {};
    $('mhLogo').textContent = b.logoText || tenant.name.slice(0, 2).toUpperCase();
    $('mhName').textContent = b.headerName || tenant.name;
    $('mhOrg').textContent = [kase.eyebrow, tenant.org?.name].filter(Boolean).join(' · ');
    $('mhHeadline').textContent = kase.headline || b.tagline || b.headerSub || '';
    $('mhTagline').textContent = kase.headline ? (b.tagline || b.headerSub || '') : '';
    $('ctaBtn').textContent = tenant.cta.share;
    $('ctaBtn').addEventListener('click', () => onShare?.());
    $('mapSrc').textContent = tenant.overlays?.attribution || '';
    $('footOrg').textContent = tenant.org?.name || tenant.name;
    if (kase.export) {
      $('exportBtn').hidden = false;
      $('exportBtn').innerHTML = `${icon('download', 13)} ${esc(kase.export)}`;
      $('exportBtn').addEventListener('click', exportCsv);
    }
    renderFilters();
  }

  /* ── the stat tiles ─────────────────────────────────────────────
     { metric: "count" } stays live; { value, label } is the tenant's own
     editorial claim. Re-rendered with the data so the count is never stale. */
  function renderStats() {
    const stats = Array.isArray(kase.stats) ? kase.stats : [];
    if (!stats.length) { $('caseStats').hidden = true; return; }
    $('caseStats').hidden = false;
    $('caseStats').innerHTML = stats.map(st => {
      const live = st.metric === 'count';
      const value = live ? String(stories.length) : st.value ?? '';
      const label = live ? (st.label || noun[1]) : st.label || '';
      return `<div class="stat${st.accent ? ' stat-accent' : ''}">
        <span class="stat-n">${esc(value)}</span>
        <span class="stat-l">${esc(label)}</span>
      </div>`;
    }).join('');
  }

  function renderFilters() {
    if (!filterFields.length) { $('filterRow').style.display = 'none'; return; }
    $('filterRow').innerHTML = filterFields.map(f => `
      <label class="rf">
        <span class="rf-lbl">${esc(f.filterLabel || f.legendTitle || f.label)}</span>
        <select class="rf-sel" data-f="${esc(f.id)}">
          <option value="">All</option>
          ${f.options.map(o =>
            `<option value="${esc(o.id)}"${active[f.id] === o.id ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select>
      </label>`).join('');
    $('filterRow').querySelectorAll('.rf-sel').forEach(sel =>
      sel.addEventListener('change', () => {
        if (sel.value) active[sel.dataset.f] = sel.value;
        else delete active[sel.dataset.f];
        renderLedger();
        onFilterChange?.();
      }));
  }

  function filtered() {
    return stories.filter(s =>
      Object.entries(active).every(([fid, v]) => s.answers?.[fid] === v));
  }

  function renderCount() {
    const n = stories.length;
    const last = n
      ? new Date(Math.max(...stories.map(s => +new Date(s.submitted_at))))
      : null;
    $('mhCount').innerHTML =
      `<strong>${n}</strong> ${esc(n === 1 ? noun[0] : noun[1])} ${esc(opts.countSuffix || 'on the record')}` +
      (last ? `<span class="mh-dot">·</span>last added ${esc(
        last.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }))}` : '');
  }

  function renderLedger() {
    // № is a story's permanent place in the record: chronological rank in
    // the full list, unaffected by filters. Display runs newest-first.
    const byDate = [...stories].sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));
    const no = new Map(byDate.map((s, i) => [s.id, i + 1]));
    const list = filtered().sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));

    $('ledger').innerHTML = list.map(s => row(s, no.get(s.id))).join('') ||
      emptyState(tenant.feed?.emptyText || 'Nothing on the record yet.');
    $('ledger').querySelectorAll('.row').forEach(el =>
      el.addEventListener('click', () => onStoryOpen?.(el.dataset.story)));

    $('rfShowing').textContent = list.length !== stories.length
      ? `Showing ${list.length} of ${stories.length} ${noun[1]}` : '';
  }

  function row(s, n) {
    const media = s.media || [];
    const chips = chipFields
      .map(f => fieldOption(f, s.answers?.[f.id]))
      .filter(Boolean)
      .map(o => `<span class="row-chip">${esc(o.label)}</span>`).join('');
    const cut = excerpt(storyText(tenant, s), EXCERPT_CHARS);
    return `<li class="row-li">
      <button class="row" data-story="${esc(s.id)}">
        <span class="row-no" aria-hidden="true">№${n}</span>
        <span class="row-main">
          <span class="row-head">
            <span class="row-tick" style="background:${storyColor(tenant, s)}" aria-hidden="true"></span>
            <span class="row-who">${esc(byline(tenant, s))}</span>
            ${s.location_label ? `<span class="row-sep" aria-hidden="true">·</span><span class="row-place">${esc(s.location_label)}</span>` : ''}
            ${chips}
          </span>
          ${cut ? `<span class="row-excerpt">“${esc(cut)}”</span>` : ''}
        </span>
        <span class="row-media">
          ${media.some(m => m.kind === 'photo') ? icon('camera', 14) : ''}
          ${media.some(m => m.kind === 'audio') ? icon('mic', 14) : ''}
          ${media.some(m => m.kind === 'video') ? icon('video', 14) : ''}
        </span>
      </button>
    </li>`;
  }

  /* ── the evidence export ────────────────────────────────────────
     A CSV of the ledger as currently filtered: what an organizer hands to
     an agency, a lawyer, or a reporter. Public fields only — exactly what
     the page already shows. */
  function exportCsv() {
    const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const byDate = [...stories].sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));
    const no = new Map(byDate.map((s, i) => [s.id, i + 1]));
    const list = filtered().sort((a, b) => (no.get(a.id) || 0) - (no.get(b.id) || 0));

    const head = ['no', 'submitted', 'shared_by', 'place',
      ...filterFields.map(f => f.id), noun[0]];
    const rows = list.map(s => [
      no.get(s.id),
      new Date(s.submitted_at).toISOString().slice(0, 10),
      byline(tenant, s),
      s.location_label || '',
      ...filterFields.map(f => fieldOption(f, s.answers?.[f.id])?.label || ''),
      storyText(tenant, s),
    ]);
    const csv = [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n');

    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `${tenant.slug}-record.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return {
    renderStories(all) { stories = all; renderStats(); renderCount(); renderLedger(); },
    openStory: s => openStoryOverlay(tenant, s),
    closeStory: closeStoryOverlay,
    // The intake asked for a map tap; bring the map into view for it.
    onPinRequest() {
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      $('mapSection').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    },
    get filteredStories() { return filtered(); },
  };
}
