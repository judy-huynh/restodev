/* Cloudflare Turnstile, as an opt-in platform module.
   Active only when config.platform.turnstile.siteKey is present — tenants never
   configure this (anti-abuse is a horizontal capability, not a per-community
   variation). The widget runs in "interaction-only" appearance, so legitimate
   residents almost never see a challenge; the token is verified server-side by
   the /api/submit Worker before the story insert is forwarded. */

let scriptLoading = null;

function loadScript() {
  scriptLoading ||= new Promise((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile);
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve(window.turnstile);
    s.onerror = () => { scriptLoading = null; reject(new Error('turnstile script failed to load')); };
    document.head.appendChild(s);
  });
  return scriptLoading;
}

/* Render into `container` and resolve with a fresh token (tokens are single-use
   and short-lived, so this is called per submission attempt). Rejects on
   network/challenge failure — callers surface that honestly and let the user
   retry without losing their story. */
export async function getTurnstileToken(siteKey, container) {
  const ts = await loadScript();
  return new Promise((resolve, reject) => {
    container.innerHTML = '';
    let settled = false;
    let widgetId = null;
    const cleanup = () => { try { if (widgetId != null) ts.remove(widgetId); } catch { /* already gone */ } };
    const done = (fn, v) => { if (!settled) { settled = true; setTimeout(cleanup, 0); fn(v); } };
    try {
      widgetId = ts.render(container, {
        sitekey: siteKey,
        appearance: 'interaction-only',
        'refresh-expired': 'auto',
        callback: token => done(resolve, token),
        'error-callback': () => done(reject, new Error('turnstile challenge failed')),
        // Turnstile fires this when a solved token expires before use; its own
        // timing (not ours) governs a challenge in progress.
        'timeout-callback': () => done(reject, new Error('turnstile challenge timed out')),
      });
    } catch (e) {
      done(reject, e);
    }
    // Last-resort backstop only, for a widget that never calls ANY callback
    // (script wedged). Deliberately long so it can't interrupt a real person
    // working through a visible challenge — Cloudflare's own callbacks handle
    // the normal failure/expiry paths.
    setTimeout(() => done(reject, new Error('turnstile did not respond')), 150_000);
  });
}
