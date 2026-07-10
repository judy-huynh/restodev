/* Conversational intake — an alternate submission renderer.
   Same config, same data path as the stepped form (form.js): it walks the
   tenant's story-schema fields one question at a time, then consent, location,
   and optional contact, and submits the identical payload to onSubmit().
   Selected per tenant via form.intakeMode = "conversational". Trauma-informed:
   every question is skippable, nothing is required unless the field says so. */
import { esc } from './ui.js';
import { consentLevels, computeDisplayName, consentNeedsName } from './consent.js';
import { explainSubmitError } from './data.js';
import { getTurnstileToken } from './turnstile.js';
import { icon } from './ui/icons.js';

const $ = id => document.getElementById(id);

export function createChatIntake(tenant, { api, platform, mode = 'map', source, draft, onRequestPin, onSubmit, onDone, onClose }) {
  let answers = {}, consent = 'anonymous', contact = { name: '', email: '', phone: '' };
  let mediaFiles = [], pendingLat = null, pendingLng = null;
  let plan = [], pi = 0, submitting = false;
  let audioRec = null, audioChunks = [], recTimer = null, recSecs = 0, isRec = false, recFinalized = null;
  // One id per submission, reused across retries → a flaky connection can
  // never record the same account twice.
  let submissionId = null;
  let successTimer = null;
  // Bumped by reset/wipe/open; a submit in flight aborts if it changes.
  let generation = 0;

  const fields = tenant.storySchema.fields;
  const locField = fields.find(f => tenant.storySchema.roles?.locationLabel === f.id);
  const media = tenant.form?.media || {};
  const mediaEnabled = media.photo || media.audio || media.video;
  const locationEnabled = tenant.form?.location?.enabled !== false;

  // ── message helpers ───────────────────────────────────────────
  const scroll = () => $('chatScroll');
  function bottom() { const s = scroll(); s.scrollTop = s.scrollHeight; }

  function sys(html) {
    const d = document.createElement('div');
    d.className = 'cx-row sys';
    d.innerHTML = `<div class="cx-av s">${icon('chat', 13)}</div><div class="cx-bub s">${html}</div>`;
    scroll().appendChild(d);
    bottom();
  }
  function usr(text) {
    const d = document.createElement('div');
    d.className = 'cx-row usr';
    d.innerHTML = `<div class="cx-av u">${esc(initials())}</div><div class="cx-bub u">${esc(text)}</div>`;
    scroll().appendChild(d);
    bottom();
  }
  function initials() {
    const n = contact.name.trim();
    if (!n) return '·';
    const p = n.split(/\s+/);
    return (p[0][0] + (p[1] ? p[1][0] : '')).toUpperCase();
  }
  function dock(html) { $('chatDock').innerHTML = html; }
  function clearDock() { $('chatDock').innerHTML = ''; }

  // ── lifecycle ─────────────────────────────────────────────────
  function resetState() {
    generation++;
    answers = {}; consent = 'anonymous'; contact = { name: '', email: '', phone: '' };
    mediaFiles.forEach(m => { try { URL.revokeObjectURL(m.url); } catch { /* already gone */ } });
    mediaFiles = []; pendingLat = pendingLng = null; submitting = false; pi = 0;
    submissionId = null;
    clearTimeout(successTimer);
  }

  // Hard-stop the recorder without keeping its blob (kiosk wipe): a late onstop
  // must not resurrect the prior participant's audio.
  function discardRec() {
    clearInterval(recTimer);
    if (audioRec) {
      audioRec.onstop = null;
      try { if (audioRec.state !== 'inactive') audioRec.stop(); } catch { /* already stopped */ }
      try { audioRec.stream.getTracks().forEach(t => t.stop()); } catch { /* mic released */ }
      audioRec = null;
    }
    isRec = false; recSecs = 0;
  }

  function open() {
    resetState();
    scroll().innerHTML = ''; clearDock();
    $('cxLogo').textContent = tenant.branding?.logoText || tenant.name.slice(0, 2).toUpperCase();
    $('cxTitle').textContent = tenant.name;

    plan = [
      ...fields.map(f => ({ type: 'field', field: f })),
      ...(mediaEnabled ? [{ type: 'media' }] : []),
      ...(locationEnabled ? [{ type: 'location' }] : []),
      { type: 'consent' },
      { type: 'contact' },
      { type: 'submit' },
    ];

    $('chatOverlay').classList.add('open');
    (tenant.form?.intro || [
      'Take your time. You can skip any question, and you choose later how your name appears — or whether it appears at all.',
    ]).forEach(sys);

    // Share links are resumable: a resident who drops off mid-way on their own
    // phone picks up where they left off. (Drafts never exist in kiosk mode.)
    const saved = draft?.load();
    if (saved) {
      // Prune against the CURRENT config: drop answers for fields the tenant
      // has since removed, and choice answers whose option no longer exists, so
      // a stale draft can never submit junk or echo internal ids as "your words".
      answers = {};
      for (const f of fields) {
        const v = saved[f.id];
        if (v == null) continue;
        if ((f.kind === 'choice' || f.kind === 'select-chips' || f.kind === 'select')
            && !(f.options || []).some(o => o.id === v)) continue;
        answers[f.id] = v;
      }
      // Resume at the first unanswered question; answered ones are replayed
      // as a compact recap instead of re-asked.
      while (pi < plan.length && plan[pi].type === 'field' && answers[plan[pi].field.id] != null) pi++;
      if (pi > 0) {
        sys('Welcome back — I’ve kept what you shared so far. <button class="cx-link" id="cxStartOver">Not you? Start fresh</button>');
        $('chatScroll').querySelector('#cxStartOver')?.addEventListener('click', () => {
          draft?.clear();
          open(); // fresh session — nothing from the previous person remains
        });
        for (let i = 0; i < pi; i++) {
          const f = plan[i].field;
          const v = answers[f.id];
          const opt = (f.options || []).find(o => o.id === v);
          usr(opt ? opt.label : String(v));
        }
      }
    }
    runStep();
  }

  function close() {
    $('chatOverlay').classList.remove('open');
    stopRec();
    onClose?.();
  }

  /* Privacy wipe for kiosk handoffs: state, recorded audio, AND rendered
     transcript go. discardRec() prevents a late onstop from repopulating; the
     generation bump aborts any submit still awaiting the network. */
  function wipe() {
    discardRec();
    resetState();
    scroll().innerHTML = '';
    clearDock();
    $('chatOverlay').classList.remove('open');
  }

  function next() { pi++; runStep(); }

  function saveDraft() { draft?.save(answers); }

  function runStep() {
    const step = plan[pi];
    if (!step) return;
    ({ field: askField, media: askMedia, location: askLocation, consent: askConsent, contact: askContact, submit: doSubmit }[step.type])(step);
  }

  // ── field questions ───────────────────────────────────────────
  function askField({ field }) {
    sys(esc(field.chatPrompt || field.label) + (field.required ? '' : ' <span style="opacity:.6">(optional)</span>'));
    const kind = field.kind;
    if (kind === 'choice' || kind === 'select-chips' || kind === 'select') {
      const opts = (field.options || []).map(o =>
        `<button class="cx-opt" data-opt="${esc(o.id)}">${o.emoji ? o.emoji + ' ' : ''}${esc(o.label)}</button>`).join('');
      dock(`<div class="cx-opts">${opts}${field.required ? '' : '<button class="cx-opt ghost" data-skip="1">Skip</button>'}</div>`);
      $('chatDock').querySelectorAll('[data-opt]').forEach(b =>
        b.addEventListener('click', () => {
          const o = field.options.find(x => x.id === b.dataset.opt);
          answers[field.id] = o.id;
          saveDraft();
          clearDock(); usr(o.label); next();
        }));
      bindSkip(field);
    } else {
      const isLong = kind === 'longtext';
      dock(`
        ${field.placeholder ? `<div class="cx-hint">${esc(field.placeholder)}</div>` : ''}
        <div class="cx-inrow">
          <textarea class="cx-input" id="cxIn" rows="${isLong ? 3 : 1}" placeholder="Type your answer…"></textarea>
          <button class="cx-send" id="cxSend">Send</button>
        </div>
        ${field.required ? '' : '<div class="cx-opts" style="margin-top:8px"><button class="cx-opt ghost" data-skip="1">Skip this</button></div>'}`);
      const input = $('cxIn');
      input.focus();
      const send = () => {
        const v = input.value.trim();
        if (!v) { if (!field.required) { clearDock(); next(); } return; }
        answers[field.id] = v.slice(0, field.maxLength || 2000);
        saveDraft();
        clearDock(); usr(v); next();
      };
      $('cxSend').addEventListener('click', send);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      });
      bindSkip(field);
    }
  }

  function bindSkip(field) {
    $('chatDock').querySelector('[data-skip]')?.addEventListener('click', () => {
      clearDock(); usr('Skip'); next();
    });
  }

  // ── media ─────────────────────────────────────────────────────
  function askMedia() {
    sys(tenant.form?.chat?.media || 'If you have one, you can add a photo or record a voice note. This is optional.');
    renderMediaDock();
  }
  const audioMF = () => mediaFiles.filter(f => f.kind === 'audio');
  const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  function renderMediaDock() {
    const chips = mediaFiles.map(m => `<span class="cx-att">${{ photo: `${icon('camera')} Photo`, audio: `${icon('mic')} Voice note`, video: `${icon('video')} Video` }[m.kind]}</span>`).join('');
    dock(`
      ${chips ? `<div class="cx-attach">${chips}</div>` : ''}
      <div class="cx-opts">
        ${media.photo ? `<button class="cx-opt" id="cxPhoto">${icon('camera')} Add photo</button>` : ''}
        ${media.audio ? `<button class="cx-opt" id="cxRec">${isRec ? `${icon('stop')} Stop recording` : `${icon('mic')} Record voice`}</button>` : ''}
        <button class="cx-opt ghost" id="cxMediaNext">${mediaFiles.length ? 'Continue' : 'Skip'}</button>
      </div>
      ${isRec ? `<div class="cx-hint" style="margin-top:8px">Recording… ${fmt(recSecs)}</div>` : ''}
      <input type="file" id="cxFile" accept="image/*" hidden>`);
    $('cxPhoto')?.addEventListener('click', () => $('cxFile').click());
    $('cxFile')?.addEventListener('change', e => {
      Array.from(e.target.files).forEach(file => mediaFiles.push({ kind: 'photo', file, url: URL.createObjectURL(file) }));
      renderMediaDock();
    });
    $('cxRec')?.addEventListener('click', toggleRec);
    $('cxMediaNext').addEventListener('click', async () => {
      if (isRec) await stopRec();
      clearDock();
      if (mediaFiles.length) usr(`${mediaFiles.length} attachment${mediaFiles.length > 1 ? 's' : ''} added`);
      next();
    });
  }

  async function toggleRec() {
    if (isRec) { await stopRec(); renderMediaDock(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];
      audioRec = new MediaRecorder(stream);
      recFinalized = new Promise(resolve => {
        audioRec.ondataavailable = e => { if (e.data.size) audioChunks.push(e.data); };
        audioRec.onstop = () => {
          stream.getTracks().forEach(t => t.stop());
          const type = audioRec.mimeType || 'audio/webm';
          const ext = /mp4|aac/.test(type) ? 'mp4' : /ogg/.test(type) ? 'ogg' : 'webm';
          const blob = new Blob(audioChunks, { type });
          mediaFiles = mediaFiles.filter(f => f.kind !== 'audio');
          mediaFiles.push({ kind: 'audio', file: new File([blob], `voice.${ext}`, { type }), url: URL.createObjectURL(blob) });
          isRec = false; recSecs = 0; clearInterval(recTimer);
          resolve();
        };
      });
      audioRec.start();
      isRec = true; recSecs = 0;
      recTimer = setInterval(() => { recSecs++; renderMediaDock(); }, 1000);
      renderMediaDock();
    } catch { alert('Microphone access denied.'); }
  }
  async function stopRec() {
    if (audioRec && isRec) { audioRec.stop(); isRec = false; await recFinalized; }
    clearInterval(recTimer);
  }

  // ── location ──────────────────────────────────────────────────
  function askLocation() {
    sys(tenant.form?.chat?.location || 'Would you like to mark where this happened on the map? You can keep it off.');
    dock(`<div class="cx-opts">
      <button class="cx-opt" id="cxPin">${icon('pin')} Add the place</button>
      <button class="cx-opt ghost" id="cxNoPin">Keep it off the map</button>
    </div>`);
    $('cxPin').addEventListener('click', () => {
      clearDock();
      $('chatOverlay').classList.remove('open');
      sys('Tap the spot on the map.');
      onRequestPin?.();
    });
    $('cxNoPin').addEventListener('click', () => { clearDock(); usr('Kept off the map'); next(); });
  }

  function setPinLocation(lat, lng) {
    pendingLat = lat; pendingLng = lng;
    $('chatOverlay').classList.add('open');
    usr('Location added');
    next();
  }

  // ── consent ───────────────────────────────────────────────────
  function askConsent() {
    sys(esc(tenant.consent?.question || 'How should this appear?') +
      (tenant.consent?.explainer ? `<br><span style="opacity:.7;font-size:.92em">${esc(tenant.consent.explainer)}</span>` : ''));
    const opts = consentLevels(tenant).map(l =>
      `<button class="cx-opt" data-consent="${l.id}" style="display:block;width:100%">${l.emoji} ${esc(l.label)}</button>`).join('');
    dock(`<div class="cx-opts" style="flex-direction:column;align-items:stretch">${opts}</div>`);
    $('chatDock').querySelectorAll('[data-consent]').forEach(b =>
      b.addEventListener('click', () => {
        consent = b.dataset.consent;
        const level = consentLevels(tenant).find(l => l.id === consent);
        usr(level.label);
        if (consentNeedsName(consent)) askName(); else { clearDock(); next(); }
      }));
  }

  function askName() {
    sys(consent === 'first_name'
      ? 'What first name should we show? (Only a first name and last initial will appear.)'
      : 'What name should appear with this account?');
    dock(`<div class="cx-inrow">
      <textarea class="cx-input" id="cxName" rows="1" placeholder="Your name"></textarea>
      <button class="cx-send" id="cxNameSend">Save</button>
    </div>`);
    $('cxName').focus();
    const save = () => {
      const v = $('cxName').value.trim();
      if (!v) return;
      contact.name = v;
      clearDock();
      usr(computeDisplayName(consent, v) || v);
      next();
    };
    $('cxNameSend').addEventListener('click', save);
    $('cxName').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } });
  }

  // ── contact ───────────────────────────────────────────────────
  function askContact() {
    sys(tenant.form?.chat?.contact || tenant.form?.contactHint ||
      'If you are open to being contacted by the team, you can leave a way to reach you. This is never shown publicly, and it is optional.');
    dock(`
      <div class="cx-inrow" style="margin-bottom:8px">
        <textarea class="cx-input" id="cxEmail" rows="1" placeholder="Email (optional)"></textarea>
      </div>
      <div class="cx-inrow">
        <textarea class="cx-input" id="cxPhone" rows="1" placeholder="Phone (optional)"></textarea>
      </div>
      <div class="cx-opts" style="margin-top:10px">
        <button class="cx-opt" id="cxContactDone">Continue</button>
      </div>`);
    $('cxContactDone').addEventListener('click', () => {
      contact.email = $('cxEmail').value.trim();
      contact.phone = $('cxPhone').value.trim();
      clearDock();
      if (contact.email || contact.phone) usr('Contact details added');
      next();
    });
  }

  // ── submit ────────────────────────────────────────────────────
  function retryDock(extra) {
    dock(`<div class="cx-opts">
      <button class="cx-opt" id="cxRetry">Try again</button>
      ${extra || ''}
    </div>`);
    $('cxRetry').addEventListener('click', () => { pi = plan.length - 1; clearDock(); runStep(); });
  }

  async function doSubmit() {
    if (submitting) return;
    submitting = true;
    submissionId ||= crypto.randomUUID();
    const gen = generation; // abort if a kiosk wipe lands mid-submit
    sys(tenant.form?.chat?.submitting || 'Recording your account…');

    // Uploads one at a time; files that already made it are never re-sent on
    // a retry. A failed file is an honest choice, not a dead end.
    const uploaded = [];
    for (const m of mediaFiles) {
      if (!m.remote) {
        try {
          m.remote = await api.uploadMedia(m.file, m.kind);
        } catch (e) {
          if (gen !== generation) return;
          console.error(e);
          submitting = false;
          sys(esc(`Your ${m.kind === 'audio' ? 'voice note' : m.kind} couldn’t be uploaded. Everything you shared is still here.`));
          retryDock(`<button class="cx-opt ghost" id="cxDropMedia">Send without it</button>`);
          $('cxDropMedia').addEventListener('click', () => {
            mediaFiles = mediaFiles.filter(f => f !== m);
            pi = plan.length - 1; clearDock(); runStep();
          });
          return;
        }
      }
      if (gen !== generation) return;
      uploaded.push(m.remote);
    }

    try {
      let turnstileToken = null;
      if (platform?.turnstile?.siteKey) {
        turnstileToken = await getTurnstileToken(platform.turnstile.siteKey, tsBox());
      }
      if (gen !== generation) return;
      await onSubmit({
        id: submissionId,
        consentLevel: consent,
        displayName: computeDisplayName(consent, contact.name),
        answers,
        lat: pendingLat,
        lng: pendingLng,
        locationLabel: locField ? answers[locField.id] || null : null,
        media: uploaded,
        source,
        turnstileToken,
        contact: {
          full_name: contact.name.trim() || null,
          email: contact.email.trim() || null,
          phone: contact.phone.trim() || null,
        },
      });
      if (gen !== generation) return; // wiped between the post and the paint
      draft?.clear();
      const ref = submissionId.slice(-6).toUpperCase();
      sys(`<strong>${esc(tenant.cta.successTitle || 'Thank you.')}</strong><br>${esc(tenant.cta.successBody || 'Your account has been recorded and will be reviewed before it appears.')}<br><span class="cx-ref">Your reference: <strong>#${ref}</strong></span>${mode === 'kiosk' ? '<br><em>Please hand the device back — this screen clears itself for the next person.</em>' : ''}`);
      dock(`<div class="cx-opts">
        <button class="cx-opt" id="cxDone">Done</button>
      </div>`);
      $('cxDone').addEventListener('click', () => { close(); onDone?.(); });
      if (mode === 'kiosk') {
        successTimer = setTimeout(() => { close(); onDone?.(); }, 30_000);
      }
    } catch (e) {
      if (gen !== generation) return;
      console.error(e);
      submitting = false;
      sys(esc(explainSubmitError(e).text));
      retryDock();
    }
  }

  // Turnstile renders (usually invisibly) into the dock area right before send.
  function tsBox() {
    let box = $('cxTsBox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'cxTsBox';
      box.className = 'ts-box';
      $('chatDock').appendChild(box);
    }
    return box;
  }

  return { open, close, wipe, setPinLocation, get pending() { return { lat: pendingLat, lng: pendingLng }; } };
}
