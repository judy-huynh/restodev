/* Moderation dashboard. Real Supabase auth (GoTrue password grant) —
   moderator access is enforced by RLS through tenant_members, so this UI
   only ever sees the tenants its signed-in user belongs to. */
import { loadConfig, applyTheme, roleField, fieldOption, storyGradient, storyText } from './config.js';
import { esc } from './ui.js';
import { CONSENT_LEVELS } from './consent.js';

const $ = id => document.getElementById(id);
const SESSION_KEY = 'gt-admin-session';

let platform, tenant, tenantId;
let session = null;
let stories = [];
let contacts = {};
let activeTab = 'pending';
let modalStoryId = null;
let myRole = null;        // 'owner' unlocks notification settings
let pollTimer = null;     // live pending-count poll
const baseTitle = () => `${tenant.name} — Admin`;

// ── auth ──────────────────────────────────────────────────────────
function saveSession(s) {
  session = s ? { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at, user: s.user } : null;
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
}

async function login(email, password) {
  const res = await fetch(`${platform.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: platform.publishableKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(data.error_description || data.msg || 'sign-in failed');
  saveSession(data);
}

// A single shared refresh promise so concurrent authed() calls near expiry
// don't each POST the same refresh token (GoTrue rotates it — the losers of
// that race would 400 and needlessly drop a session that just refreshed).
let refreshInflight = null;
async function refreshIfNeeded() {
  if (!session) return false;
  if (session.expires_at * 1000 - Date.now() > 60_000) return true;
  if (!refreshInflight) {
    refreshInflight = (async () => {
      const res = await fetch(`${platform.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: platform.publishableKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      if (!res.ok) { saveSession(null); return false; }
      saveSession(await res.json());
      return true;
    })().finally(() => { refreshInflight = null; });
  }
  return refreshInflight;
}

// Signals that the session is gone and the UI must return to the login screen.
class SessionExpired extends Error {}

// Bounce back to the login form when the session can't be recovered.
function forceLogin() {
  saveSession(null);
  clearInterval(pollTimer); // stop the poll from re-firing forceLogin every tick
  // Close every modal — a story-detail modal shows never-public contact info,
  // which must never linger over the login screen on a shared machine.
  document.querySelectorAll('.modal-bg').forEach(m => m.classList.remove('open'));
  $('modalBody').innerHTML = '';
  $('dashboard').style.display = 'none';
  $('loginWrap').style.display = '';
  $('loginErr').textContent = 'Your session expired — please sign in again.';
  $('loginErr').classList.add('show');
}

async function authed(path, opts = {}) {
  if (!(await refreshIfNeeded())) throw new SessionExpired('session expired');
  const res = await fetch(`${platform.supabaseUrl}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: platform.publishableKey,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  // A 401 mid-session means the token was revoked out from under us.
  if (res.status === 401) { saveSession(null); throw new SessionExpired('unauthorized'); }
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── data ──────────────────────────────────────────────────────────
async function loadStories() {
  const rows = await authed(`tenants?slug=eq.${encodeURIComponent(tenant.slug)}&select=id`);
  if (!rows.length) throw new Error('tenant missing');
  tenantId = rows[0].id;

  const memberships = await authed(`tenant_members?select=tenant_id,role&tenant_id=eq.${tenantId}`);
  if (!memberships.length) {
    showToast('⚠️ Your account is not a moderator for this community.');
    stories = []; contacts = {};
    return;
  }
  myRole = memberships[0].role;
  $('notifyBtn').style.display = myRole === 'owner' ? '' : 'none';

  [stories, contacts] = await Promise.all([
    authed(`stories?tenant_id=eq.${tenantId}&select=*&order=submitted_at.desc`),
    authed(`story_contacts?tenant_id=eq.${tenantId}&select=*`)
      .then(rows => Object.fromEntries(rows.map(c => [c.story_id, c]))),
  ]);
}

const statusOf = s => s.status;

// ── rendering ─────────────────────────────────────────────────────
function updateStats() {
  const n = k => stories.filter(s => s.status === k).length;
  $('stTotal').textContent = stories.length;
  $('stPend').textContent = n('pending');
  $('stAppr').textContent = n('approved');
  $('stRej').textContent = n('rejected');
  $('tPend').textContent = n('pending');
  $('tAppr').textContent = n('approved');
  $('tRej').textContent = n('rejected');
  $('tAll').textContent = stories.length;
  // The tab title is the always-visible pending badge.
  const pend = n('pending');
  document.title = pend ? `(${pend}) ${baseTitle()}` : baseTitle();
}

// ── live pending count ────────────────────────────────────────────
// A moderator with the dashboard open learns about new work without
// refreshing: poll the pending set every 30s (tiny query — ids only).
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (document.hidden) return;
    try {
      const rows = await authed(`stories?tenant_id=eq.${tenantId}&status=eq.pending&select=id`);
      const known = new Set(stories.filter(s => s.status === 'pending').map(s => s.id));
      const fresh = rows.filter(r => !known.has(r.id));
      if (fresh.length || rows.length !== known.size) {
        await loadStories();
        rerender();
        if (fresh.length) showToast(`📥 ${fresh.length === 1 ? 'A new story is' : `${fresh.length} new stories are`} waiting for review`);
      }
    } catch (e) {
      if (e instanceof SessionExpired) { clearInterval(pollTimer); forceLogin(); }
      // transient network errors: stay quiet, try again next tick
    }
  }, 30_000);
}

// ── notification settings (tenant owners only) ────────────────────
// Recipient addresses live in the private tenant_settings table (RLS:
// owners). This panel is the assignable-recipients UI on top of it.
const notify = {
  async open() {
    $('notifyErr').classList.remove('show');
    try {
      const [row] = await authed(`tenant_settings?tenant_id=eq.${tenantId}&select=*`);
      $('notifyEmails').value = (row?.notify_emails || []).join('\n');
      const mode = row?.notify_mode || 'immediate';
      document.querySelectorAll('#notifyModes input').forEach(r => { r.checked = r.value === mode; });
      $('notifyBg').classList.add('open');
      this.renderLog();
    } catch (e) { handleActionError(e, '⚠️ Could not load alert settings'); }
  },
  async renderLog() {
    try {
      const log = await authed(`notification_log?tenant_id=eq.${tenantId}&select=kind,status,detail,created_at&order=created_at.desc&limit=5`);
      $('notifyLog').innerHTML = log.length
        ? `<div class="modal-lbl">Recent alerts</div>` + log.map(l => `
            <div class="nlog-row">
              <span class="nlog-status ${esc(l.status)}">${esc(l.status)}</span>
              <span>${esc(l.kind)} · ${new Date(l.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
              <span class="nlog-detail">${esc(l.detail || '')}</span>
            </div>`).join('')
        : '<div style="font-size:.7rem;color:var(--muted)">No alerts sent yet.</div>';
    } catch { $('notifyLog').innerHTML = ''; }
  },
  async save() {
    const emails = $('notifyEmails').value.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
    const bad = emails.filter(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    const err = $('notifyErr');
    if (bad.length) {
      err.textContent = `Not a valid email: ${bad[0]}`;
      err.classList.add('show');
      return;
    }
    const mode = document.querySelector('#notifyModes input:checked')?.value || 'immediate';
    if (mode !== 'off' && !emails.length) {
      err.textContent = 'Add at least one recipient, or switch alerts off.';
      err.classList.add('show');
      return;
    }
    err.classList.remove('show');
    try {
      await authed('tenant_settings', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ tenant_id: tenantId, notify_emails: emails, notify_mode: mode, updated_at: new Date().toISOString() }),
      });
      $('notifyBg').classList.remove('open');
      showToast('🔔 Alert settings saved');
    } catch (e) { handleActionError(e, '⚠️ Could not save alert settings'); }
  },
};

function consentBadge(level) {
  const meta = CONSENT_LEVELS.find(l => l.id === level);
  const warn = level === 'advocacy_only'
    ? 'style="background:#FEF3C7;border:1px solid #F59E0B;color:#92400E"' : '';
  return `<span class="sc-cat" ${warn} title="${esc(meta?.desc || '')}">${meta?.emoji || ''} ${esc(meta?.label || level)}</span>`;
}

function storyCard(s) {
  const colorField = roleField(tenant, 'color');
  const catField = roleField(tenant, 'filter');
  const typeOpt = fieldOption(colorField, s.answers?.[colorField?.id]);
  const catOpt = fieldOption(catField, s.answers?.[catField?.id]);
  const c = contacts[s.id] || {};
  const media = s.media || [];
  const dt = new Date(s.submitted_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const col = typeOpt?.color || 'var(--primary)';
  const status = statusOf(s);

  return `<div class="scard ${status}" id="card-${s.id}">
    <div class="sc-head">
      <div class="sc-dot" style="background:${col}"></div>
      <div class="sc-info">
        <div class="sc-name">${esc(c.full_name || s.display_name || 'Anonymous')}</div>
        <div class="sc-loc">${esc(s.location_label || 'Location not specified')}${s.lat ? ` · 📍 ${(+s.lat).toFixed(4)}, ${(+s.lng).toFixed(4)}` : ''}</div>
      </div>
      <div class="sc-meta">
        <div class="sc-date">${dt}</div>
        <div class="sc-status ${status}">${{ pending: '⏳ Pending', approved: '✓ Live', rejected: '✕ Rejected' }[status]}</div>
      </div>
    </div>
    <div class="sc-body">
      <div class="sc-type-row">
        ${typeOpt ? `<span class="sc-type" style="background:${col}">${typeOpt.emoji || ''} ${esc(typeOpt.label)}</span>` : ''}
        ${catOpt ? `<span class="sc-cat">${catOpt.emoji || ''} ${esc(catOpt.label)}</span>` : ''}
        ${consentBadge(s.consent_level)}
      </div>
      <div class="sc-text" data-open="${s.id}" style="cursor:pointer" title="Click for full story">${esc(storyText(tenant, s))}</div>
      <div class="sc-contact">
        ${c.email ? `<a href="mailto:${esc(c.email)}">✉️ ${esc(c.email)}</a>` : '<span style="font-size:.65rem;color:var(--muted)">✉️ No email</span>'}
        ${c.phone ? `<a href="tel:${esc(c.phone)}">📞 ${esc(c.phone)}</a>` : ''}
      </div>
      ${media.length ? `<div class="sc-media">${media.map(m =>
        `<span class="sc-media-badge">${{ photo: '📷', video: '🎥', audio: '🎙' }[m.kind] || '📎'} ${m.kind}</span>`).join('')}</div>` : ''}
    </div>
    <div class="sc-actions">
      ${status !== 'approved'
        ? `<button class="btn-approve" data-act="approve" data-id="${s.id}">✓ Approve</button>`
        : `<span style="font-size:.7rem;color:var(--emerald);font-weight:700;padding:8px 6px">✓ Approved ${s.approved_at ? new Date(s.approved_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}</span>`}
      ${status !== 'rejected' ? `<button class="btn-reject" data-act="reject" data-id="${s.id}">✕ Reject</button>` : ''}
      <button class="btn-delete" data-act="delete" data-id="${s.id}" title="Permanently delete this story and its media">🗑</button>
    </div>
  </div>`;
}

function renderGrid() {
  let list = activeTab === 'all' ? [...stories] : stories.filter(s => statusOf(s) === activeTab);
  if (activeTab === 'all') {
    list.sort((a, b) => (b.status === 'pending') - (a.status === 'pending') || new Date(b.submitted_at) - new Date(a.submitted_at));
  }
  const empty = { pending: 'No stories pending review. 🎉', approved: 'No approved stories yet.', rejected: 'No rejected stories.', all: 'No stories submitted yet.' };
  $('storyGrid').innerHTML = list.length
    ? list.map(storyCard).join('')
    : `<div class="empty"><span class="empty-ico">📭</span>${empty[activeTab]}</div>`;

  $('storyGrid').querySelectorAll('[data-act]').forEach(b =>
    b.addEventListener('click', () => actions[b.dataset.act](b.dataset.id)));
  $('storyGrid').querySelectorAll('[data-open]').forEach(el =>
    el.addEventListener('click', () => openModal(el.dataset.open)));
}

function rerender() { updateStats(); renderGrid(); }

// If an action failed because the session died, bounce to login instead of
// showing a generic error the moderator can't act on.
function handleActionError(e, fallback) {
  console.error(e);
  if (e instanceof SessionExpired) forceLogin();
  else showToast(fallback);
}

// ── moderation actions ────────────────────────────────────────────
const actions = {
  async approve(id) {
    try {
      await authed(`stories?id=eq.${id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'approved', approved_at: new Date().toISOString(), rejected_at: null }),
      });
      const s = stories.find(x => x.id === id);
      if (s) { s.status = 'approved'; s.approved_at = new Date().toISOString(); s.rejected_at = null; }
      rerender();
      showToast('✓ Story approved and now live on the map');
    } catch (e) { handleActionError(e, '⚠️ Approve failed'); }
  },
  async reject(id) {
    if (!confirm('Reject this story? It will be hidden from the public map.')) return;
    try {
      await authed(`stories?id=eq.${id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'rejected', rejected_at: new Date().toISOString(), approved_at: null }),
      });
      const s = stories.find(x => x.id === id);
      if (s) { s.status = 'rejected'; s.rejected_at = new Date().toISOString(); s.approved_at = null; }
      rerender();
      showToast('Story rejected and removed from public map');
    } catch (e) { handleActionError(e, '⚠️ Reject failed'); }
  },
  async delete(id) {
    if (!confirm('Permanently delete this story? Its media files are removed too. This cannot be undone.')) return;
    try {
      const s = stories.find(x => x.id === id);
      // Delete the DB row first (contacts cascade) using a guaranteed-fresh
      // token, then best-effort the storage objects with that same token.
      await authed(`stories?id=eq.${id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      let orphaned = 0;
      for (const m of s?.media || []) {
        const path = m.url.split('/storage/v1/object/public/story-media/')[1];
        if (!path) continue;
        const res = await fetch(`${platform.supabaseUrl}/storage/v1/object/story-media/${path}`, {
          method: 'DELETE',
          headers: { apikey: platform.publishableKey, Authorization: `Bearer ${session.access_token}` },
        }).catch(() => null);
        if (!res || !res.ok) orphaned++;
      }
      stories = stories.filter(x => x.id !== id);
      delete contacts[id];
      rerender();
      showToast(orphaned ? `🗑 Story deleted (${orphaned} media file(s) could not be removed)` : '🗑 Story deleted');
    } catch (e) { handleActionError(e, '⚠️ Delete failed'); }
  },
};

// ── detail modal ──────────────────────────────────────────────────
function openModal(id) {
  const s = stories.find(x => x.id === id);
  if (!s) return;
  modalStoryId = id;
  const c = contacts[id] || {};
  const [g1, g2] = storyGradient(tenant, s);
  const colorField = roleField(tenant, 'color');
  const typeOpt = fieldOption(colorField, s.answers?.[colorField?.id]);
  const dt = new Date(s.submitted_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const media = s.media || [];

  $('modalHead').style.cssText = `background:linear-gradient(135deg,${g1},${g2})`;
  $('modalHead').innerHTML = `
    <div class="modal-type">${typeOpt ? `${typeOpt.emoji || ''} ${esc(typeOpt.label)}` : 'Story'}</div>
    <div class="modal-name">${esc(c.full_name || s.display_name || 'Anonymous')}</div>
    <div class="modal-meta">
      ${s.location_label ? `<span>📍 ${esc(s.location_label)}</span>` : ''}
      <span>🗓 ${dt}</span>
      ${consentBadge(s.consent_level)}
    </div>`;

  const answerRows = tenant.storySchema.fields.map(f => {
    const v = s.answers?.[f.id];
    if (!v) return '';
    const opt = fieldOption(f, v);
    return `<div class="mc-item"><div class="mc-key">${esc(f.label)}</div><div class="mc-val">${esc(opt ? opt.label : v)}</div></div>`;
  }).join('');

  $('modalBody').innerHTML = `
    <div class="modal-section">
      <div class="modal-lbl">Story</div>
      <div class="modal-text">${esc(storyText(tenant, s)).replace(/\n/g, '<br>')}</div>
    </div>
    <div class="modal-section">
      <div class="modal-lbl">All Answers</div>
      <div class="modal-contact-grid">${answerRows}</div>
    </div>
    <div class="modal-section">
      <div class="modal-lbl">Contact Info (never public)</div>
      <div class="modal-contact-grid">
        <div class="mc-item"><div class="mc-key">Name</div><div class="mc-val">${esc(c.full_name || '—')}</div></div>
        <div class="mc-item"><div class="mc-key">Email</div><div class="mc-val">${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '—'}</div></div>
        <div class="mc-item"><div class="mc-key">Phone</div><div class="mc-val">${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '—'}</div></div>
        <div class="mc-item"><div class="mc-key">Public byline</div><div class="mc-val">${esc(s.display_name || 'Anonymous')}</div></div>
      </div>
    </div>
    ${s.lat ? `<div class="modal-section">
      <div class="modal-lbl">Location</div>
      <div style="font-size:.78rem;color:var(--muted)">
        ${esc(s.location_label || '')} · ${(+s.lat).toFixed(5)}, ${(+s.lng).toFixed(5)}
        <a href="https://www.google.com/maps?q=${+s.lat},${+s.lng}" target="_blank" style="color:var(--primary-d);margin-left:8px">Open in Maps ↗</a>
      </div>
    </div>` : ''}
    ${media.filter(m => m.kind === 'photo').length ? `<div class="modal-section">
      <div class="modal-lbl">Photos</div>
      <div class="modal-gallery">${media.filter(m => m.kind === 'photo').map(m =>
        `<img class="mg-img" src="${esc(m.url)}" data-open-url="${esc(m.url)}">`).join('')}</div>
    </div>` : ''}
    ${media.filter(m => m.kind === 'video').map(m =>
      `<div class="modal-section"><div class="modal-lbl">Video</div>
       <video controls style="width:100%;border-radius:8px;max-height:200px"><source src="${esc(m.url)}"></video></div>`).join('')}
    ${media.filter(m => m.kind === 'audio').map(m =>
      `<div class="modal-section"><div class="modal-lbl">Audio</div>
       <audio controls style="width:100%;margin-top:4px" src="${esc(m.url)}"></audio></div>`).join('')}`;

  // Never put attacker-controlled media URLs into inline handlers: the browser
  // HTML-decodes entities before compiling inline JS, so esc() in a JS context
  // is not enough. Attach behavior via dataset + addEventListener instead.
  $('modalBody').querySelectorAll('[data-open-url]').forEach(el =>
    el.addEventListener('click', () => window.open(el.dataset.openUrl, '_blank', 'noopener')));

  $('modalApprove').style.display = s.status === 'approved' ? 'none' : 'block';
  $('modalReject').style.display = s.status === 'rejected' ? 'none' : 'block';
  $('modalBg').classList.add('open');
}

function closeModal() {
  $('modalBg').classList.remove('open');
  $('modalBody').innerHTML = ''; // stop any video/audio still playing
  modalStoryId = null;
}

// ── export (data sovereignty: the community can take everything) ──
function download(filename, text, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

const stamp = () => new Date().toISOString().slice(0, 10);

const exporters = {
  json() {
    download(`${tenant.slug}-export-${stamp()}.json`, JSON.stringify({
      tenant: { slug: tenant.slug, name: tenant.name },
      exported_at: new Date().toISOString(),
      stories: stories.map(s => ({ ...s, contact: contacts[s.id] || null })),
    }, null, 2));
  },
  geojson() {
    const features = stories
      .filter(s => s.status === 'approved' && s.consent_level !== 'advocacy_only' && s.lat != null)
      .map(s => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
        properties: {
          id: s.id, display_name: s.display_name, consent_level: s.consent_level,
          location_label: s.location_label, submitted_at: s.submitted_at, ...s.answers,
        },
      }));
    download(`${tenant.slug}-public-${stamp()}.geojson`,
      JSON.stringify({ type: 'FeatureCollection', features }, null, 2), 'application/geo+json');
  },
  csv() {
    const fieldIds = tenant.storySchema.fields.map(f => f.id);
    const cols = ['id', 'status', 'consent_level', 'display_name', ...fieldIds,
      'lat', 'lng', 'location_label', 'submitted_at', 'contact_name', 'contact_email', 'contact_phone'];
    // Neutralize spreadsheet formula injection: a leading =,+,-,@ (or tab/CR)
    // makes Excel/Sheets evaluate attacker-supplied story text as a formula.
    const cell = v => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const rows = stories.map(s => {
      const c = contacts[s.id] || {};
      return [s.id, s.status, s.consent_level, s.display_name,
        ...fieldIds.map(f => s.answers?.[f]),
        s.lat, s.lng, s.location_label, s.submitted_at,
        c.full_name, c.email, c.phone].map(cell).join(',');
    });
    download(`${tenant.slug}-export-${stamp()}.csv`, [cols.join(','), ...rows].join('\n'), 'text/csv');
  },
};

// ── toast ─────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

// ── boot ──────────────────────────────────────────────────────────
async function showDashboard() {
  $('loginWrap').style.display = 'none';
  $('dashboard').style.display = 'block';
  $('hdrUser').innerHTML = `Signed in as <strong>${esc(session.user?.email || '')}</strong>`;
  try {
    await loadStories();
    rerender();
    startPolling();
  } catch (e) {
    console.error(e);
    if (e instanceof SessionExpired) { forceLogin(); return; }
    $('storyGrid').innerHTML = `<div class="empty"><span class="empty-ico">⚠️</span>Could not load stories: ${esc(e.message)}</div>`;
  }
}

async function main() {
  ({ platform, tenant } = await loadConfig());
  applyTheme(tenant);
  document.title = `${tenant.name} — Admin`;

  const logo = tenant.branding?.logoText || tenant.name.slice(0, 2).toUpperCase();
  $('loginLogo').textContent = logo;
  $('hdrLogo').textContent = logo;
  $('loginTitle').textContent = `${tenant.name} Admin`;
  $('loginSub').textContent = `${tenant.org?.name || ''} — Story Review Dashboard`;
  $('hdrName').textContent = `${tenant.name} Admin`;

  $('loginBtn').addEventListener('click', doLogin);
  $('pwInput').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  $('logoutBtn').addEventListener('click', () => { saveSession(null); location.reload(); });
  document.querySelectorAll('.tab').forEach(t =>
    t.addEventListener('click', () => {
      activeTab = t.dataset.tab;
      document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === t));
      renderGrid();
    }));
  $('modalClose').addEventListener('click', closeModal);
  $('modalBg').addEventListener('click', e => { if (e.target.id === 'modalBg') closeModal(); });
  $('modalApprove').addEventListener('click', async () => { await actions.approve(modalStoryId); closeModal(); });
  $('modalReject').addEventListener('click', async () => { await actions.reject(modalStoryId); closeModal(); });
  $('exportBtn').addEventListener('click', () => $('exportBg').classList.add('open'));
  $('exportClose').addEventListener('click', () => $('exportBg').classList.remove('open'));
  $('exportBg').addEventListener('click', e => { if (e.target.id === 'exportBg') $('exportBg').classList.remove('open'); });
  $('expJson').addEventListener('click', exporters.json);
  $('expGeojson').addEventListener('click', exporters.geojson);
  $('expCsv').addEventListener('click', exporters.csv);
  $('notifyBtn').addEventListener('click', () => notify.open());
  $('notifyClose').addEventListener('click', () => $('notifyBg').classList.remove('open'));
  $('notifyBg').addEventListener('click', e => { if (e.target.id === 'notifyBg') $('notifyBg').classList.remove('open'); });
  $('notifySave').addEventListener('click', () => notify.save());

  async function doLogin() {
    $('loginErr').classList.remove('show');
    try {
      await login($('emailInput').value.trim(), $('pwInput').value);
      await showDashboard();
    } catch (e) {
      console.error(e);
      $('loginErr').classList.add('show');
    }
  }

  const stored = localStorage.getItem(SESSION_KEY);
  if (stored) {
    session = JSON.parse(stored);
    if (await refreshIfNeeded()) await showDashboard();
    else saveSession(null);
  }
}

main().catch(e => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend',
    `<div style="position:fixed;inset:auto 16px 16px 16px;background:#fff;border:2px solid #D63B3B;border-radius:10px;padding:14px;z-index:99;font-size:.85rem">Admin failed to start: ${String(e.message).replace(/[<>]/g, '')}</div>`);
});
