/* Config loading + theming.
   Every deployment directory contains a config.json produced by the build:
   { platform: { supabaseUrl, publishableKey }, tenant: { ...tenant.json } }
   The engine renders everything from this object; there is no tenant-specific
   code anywhere in engine/. */

const REQUIRED = ['slug', 'name', 'theme', 'map', 'storySchema', 'cta'];

export async function loadConfig() {
  const res = await fetch('./config.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`config.json missing (${res.status})`);
  const cfg = await res.json();
  const missing = REQUIRED.filter(k => !(k in (cfg.tenant || {})));
  if (!cfg.platform?.supabaseUrl || !cfg.platform?.publishableKey) {
    throw new Error('config.platform is incomplete');
  }
  if (missing.length) throw new Error(`tenant config missing: ${missing.join(', ')}`);
  return cfg;
}

const THEME_VARS = {
  primary: '--primary',
  primaryDark: '--primary-d',
  primaryLight: '--primary-l',
  accent: '--accent',
  danger: '--danger',
  text: '--text',
  muted: '--muted',
  border: '--border',
  bg: '--bg',
};

export function applyTheme(tenant) {
  const root = document.documentElement;
  for (const [key, cssVar] of Object.entries(THEME_VARS)) {
    if (tenant.theme[key]) root.style.setProperty(cssVar, tenant.theme[key]);
  }
  if (tenant.theme.font) root.style.setProperty('--font', tenant.theme.font);
  // Optional display face for brand + section titles (falls back to --font).
  if (tenant.theme.fontDisplay) root.style.setProperty('--font-display', tenant.theme.fontDisplay);
  // Optional call-to-action styling, independent of the primary brand color,
  // so a tenant can lead with a different, more inviting color on "share".
  if (tenant.theme.cta) root.style.setProperty('--cta', tenant.theme.cta);
  if (tenant.theme.ctaText) root.style.setProperty('--cta-text', tenant.theme.ctaText);
  if (tenant.theme.ctaShadow) root.style.setProperty('--cta-shadow', tenant.theme.ctaShadow);
  // Optional header treatment: "clean" swaps the gradient bar for a light,
  // solid surface. Default (unset) keeps the gradient.
  if (tenant.theme.headerStyle) root.dataset.header = tenant.theme.headerStyle;
  if (tenant.theme.headerBg) root.style.setProperty('--header-bg', tenant.theme.headerBg);
  // Optional logo tile treatment (accepts any CSS background, gradients welcome).
  if (tenant.theme.logoBg) root.style.setProperty('--logo-bg', tenant.theme.logoBg);
  document.title = tenant.branding?.title || tenant.name;
  if (tenant.branding?.language) {
    document.documentElement.lang = tenant.branding.language;
  }
}

/* Convenience accessors over the story schema. */
export function schemaField(tenant, id) {
  return tenant.storySchema.fields.find(f => f.id === id) || null;
}

export function roleField(tenant, role) {
  const id = tenant.storySchema.roles?.[role];
  return id ? schemaField(tenant, id) : null;
}

export function fieldOption(field, optionId) {
  return field?.options?.find(o => o.id === optionId) || null;
}

/* Color for a story pin: option color of the "color"-role field. */
export function storyColor(tenant, story, fallback) {
  const field = roleField(tenant, 'color');
  const opt = fieldOption(field, story.answers?.[field?.id]);
  return opt?.color || fallback || tenant.theme.primary;
}

export function storyGradient(tenant, story) {
  const field = roleField(tenant, 'color');
  const opt = fieldOption(field, story.answers?.[field?.id]);
  return opt?.gradient || [tenant.theme.primary, tenant.theme.accent || tenant.theme.primaryDark];
}

export function storyText(tenant, story) {
  const field = roleField(tenant, 'text');
  return (field && story.answers?.[field.id]) || '';
}

/* Optional "fun prompts" pack: playful conversation starters a tenant can
   supply to inspire submissions. Each entry is a string or { text, emoji }.
   Returns a normalized [{ text, emoji }] (emoji optional). Empty when unset,
   so every consumer degrades to its plain default. This is what re-skins the
   same collection for a wedding vs. family history vs. a trip diary. */
export function promptPack(tenant) {
  const raw = tenant.prompts;
  if (!Array.isArray(raw)) return [];
  return raw
    .map(p => (typeof p === 'string' ? { text: p } : p && typeof p.text === 'string' ? { text: p.text, emoji: p.emoji } : null))
    .filter(Boolean);
}
