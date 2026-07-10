/* Per-story consent gradient. These levels are an engine capability:
   the database enforces them again server-side (enforce_consent trigger +
   RLS), so this module is UX, not the security boundary. */
import { icon } from './ui/icons.js';

export const CONSENT_LEVELS = [
  {
    id: 'anonymous',
    emoji: icon('eyeOff'),
    label: 'Anonymous',
    desc: 'No name shown. Your story appears with no identifying details.',
  },
  {
    id: 'first_name',
    emoji: icon('user'),
    label: 'First name only',
    desc: 'Shown with your first name and last initial, like “Maria T.”',
  },
  {
    id: 'full_name',
    emoji: icon('speaker'),
    label: 'Full name',
    desc: 'Your full name appears alongside your story.',
  },
  {
    id: 'advocacy_only',
    emoji: icon('lock'),
    label: 'Advocacy only — not public',
    desc: 'Your story never appears on the public map. The organizing team may use it, anonymized, when advocating on the community’s behalf.',
  },
];

/* Tenant configs may override copy per level: consent.levels[id].{label,desc} */
export function consentLevels(tenant) {
  const overrides = tenant.consent?.levels || {};
  return CONSENT_LEVELS.map(l => ({ ...l, ...(overrides[l.id] || {}) }));
}

export function computeDisplayName(level, name) {
  const trimmed = (name || '').trim();
  if (level === 'anonymous' || level === 'advocacy_only' || !trimmed) return null;
  if (level === 'first_name') {
    const [first, second] = trimmed.split(/\s+/);
    return second ? `${first} ${second[0].toUpperCase()}.` : first;
  }
  return trimmed;
}

/* True when the chosen level needs a name typed in. */
export function consentNeedsName(level) {
  return level === 'first_name' || level === 'full_name';
}
