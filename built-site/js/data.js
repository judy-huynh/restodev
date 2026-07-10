/* Supabase data access. Plain PostgREST/GoTrue/Storage fetch — no SDK.
   The publishable key is safe to ship to the client; row-level security
   is the actual boundary (see supabase/migrations/001_init.sql). */

export function createApi(platform, tenant) {
  const base = platform.supabaseUrl;
  const key = platform.publishableKey;
  let tenantId = null;

  const headers = (token) => ({
    apikey: key,
    Authorization: `Bearer ${token || key}`,
    'Content-Type': 'application/json',
  });

  async function rest(path, opts = {}, token) {
    const res = await fetch(`${base}/rest/v1/${path}`, {
      ...opts,
      headers: { ...headers(token), ...(opts.headers || {}) },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${opts.method || 'GET'} ${path} → ${res.status}: ${body.slice(0, 300)}`);
    }
    if (res.status === 204 || opts.headers?.Prefer === 'return=minimal') return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async function resolveTenantId() {
    if (tenantId) return tenantId;
    const rows = await rest(`tenants?slug=eq.${encodeURIComponent(tenant.slug)}&select=id`);
    if (!rows?.length) throw new Error(`tenant '${tenant.slug}' not found in database`);
    tenantId = rows[0].id;
    return tenantId;
  }

  async function fetchApprovedStories() {
    const tid = await resolveTenantId();
    return rest(
      `stories?tenant_id=eq.${tid}&status=eq.approved` +
      `&select=id,display_name,consent_level,answers,lat,lng,location_label,media,submitted_at` +
      `&order=submitted_at.desc&limit=500`
    );
  }

  /* Upload one media file into the tenant's storage folder.
     Returns { url, kind }. */
  async function uploadMedia(file, kind) {
    const extByKind = { photo: 'jpg', video: 'mp4', audio: 'webm' };
    const nameExt = (file.name || '').split('.').pop()?.toLowerCase();
    const ext = (nameExt && nameExt.length <= 5 ? nameExt : null) || extByKind[kind] || 'bin';
    const path = `${tenant.slug}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    const res = await fetch(`${base}/storage/v1/object/story-media/${path}`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': file.type || 'application/octet-stream',
      },
      body: file,
    });
    if (!res.ok) throw new Error(`media upload failed: ${res.status} ${await res.text()}`);
    return { url: `${base}/storage/v1/object/public/story-media/${path}`, kind };
  }

  /* Submit a story (always lands as 'pending'; moderation is not optional).
     PII goes to the quarantined story_contacts table, never to stories.

     The caller supplies `id` (crypto.randomUUID(), reused across retries) so a
     retry after a network hiccup can never double-submit: a duplicate-key 409
     from PostgREST means the first attempt actually landed, and is success.

     When the platform has Turnstile enabled, submission goes through the
     /api/submit Worker (which verifies the token, then inserts under the same
     anon key + RLS). Otherwise it posts straight to PostgREST. */
  async function submitStory({ id, consentLevel, displayName, answers, lat, lng, locationLabel, media, contact, source, turnstileToken }) {
    const storyRow = {
      id,
      status: 'pending',
      consent_level: consentLevel,
      display_name: displayName,
      answers,
      lat,
      lng,
      location_label: locationLabel || null,
      media: media || [],
      source: source || null,
    };
    const contactRow = contact && (contact.full_name || contact.email || contact.phone)
      ? { full_name: contact.full_name || null, email: contact.email || null, phone: contact.phone || null }
      : null;

    if (platform.turnstile?.siteKey) {
      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: tenant.slug, token: turnstileToken, story: storyRow, contact: contactRow }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        const err = new Error(body.error || `submit failed (${res.status})`);
        err.code = body.code || (res.status === 403 ? 'turnstile' : 'upstream');
        throw err;
      }
      // Parity with the direct path: a dropped contact row is not a silent
      // success. The story id is stable, so a retry re-posts (409 → ok) and
      // re-attempts the contact — the resident never loses their reachback.
      if (contactRow && body.contactSaved === false) {
        const err = new Error('contact not saved');
        err.code = 'contact';
        throw err;
      }
      return id;
    }

    const tid = await resolveTenantId();
    try {
      await rest('stories', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ ...storyRow, tenant_id: tid }),
      });
    } catch (e) {
      // 409 duplicate key: this exact submission already landed on a prior try.
      if (!/409/.test(e.message)) throw e;
    }
    if (contactRow) {
      await rest('story_contacts', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ ...contactRow, story_id: id, tenant_id: tid }),
      }).catch(e => { if (!/409/.test(e.message)) throw e; });
    }
    return id;
  }

  return { base, key, rest, resolveTenantId, fetchApprovedStories, uploadMedia, submitStory };
}

/* Turn a submission failure into something a resident can act on.
   Returns { text, retryable } — every failure path keeps the user's work. */
export function explainSubmitError(e) {
  if (!navigator.onLine) {
    return { text: 'You appear to be offline. Your story is safe on this screen — reconnect and try again.', retryable: true };
  }
  if (e?.code === 'turnstile') {
    return { text: 'We couldn’t confirm you’re human just now. Please try again.', retryable: true };
  }
  if (e?.code === 'contact') {
    return { text: 'Your story was saved, but we couldn’t save your contact details. Please try again so the team can reach you.', retryable: true };
  }
  // Worker path sets code 'too-large'; the direct-PostgREST path surfaces the
  // DB size-cap trigger text inside a 400, so match that here too.
  if (e?.code === 'too-large' || /413|payload too large|too large|value too long|exceeds/i.test(e?.message || '')) {
    return { text: 'Your submission is too large — a shorter story or smaller photos will go through.', retryable: true };
  }
  return { text: 'Something went wrong sending your story. Nothing was lost — please try again.', retryable: true };
}
