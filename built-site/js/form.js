/* Multi-step submission form, rendered entirely from the tenant config:
   step 1 — the tenant's story fields (choice cards, chips, text)
   step 2 — media (only the kinds the tenant enables)
   step 3 — location (optional pin/GPS + location-step fields)
   step 4 — consent gradient + optional contact details
*/
import { esc } from './ui.js';
import { promptPack } from './config.js';
import { consentLevels, computeDisplayName, consentNeedsName } from './consent.js';
import { explainSubmitError } from './data.js';
import { getTurnstileToken } from './turnstile.js';
import { icon } from './ui/icons.js';

const $ = id => document.getElementById(id);

export function createForm(tenant, { api, platform, mode = 'map', source, stepOrder, onRequestPin, onSubmit, onDone, onClose }) {
  let step = 1;
  let answers = {};
  let contact = { name: '', email: '', phone: '' };
  let consent = 'anonymous';
  let mediaFiles = [];
  let pendingLat = null, pendingLng = null;
  let audioRec = null, audioChunks = [], recTimer = null, recSecs = 0, isRec = false;
  let submitting = false;
  let advancing = false; // guards the async step advance against double-taps
  // One id per submission, minted at first attempt and reused on retries, so
  // a flaky connection can never file the same story twice.
  let submissionId = null;
  let successTimer = null;
  // Bumped by every reset/wipe/open. A submit() in flight captures the value
  // and bails after each await if it changed — so a kiosk idle-wipe mid-submit
  // can never post a ghost story or repaint the wiped screen.
  let generation = 0;

  const media = tenant.form?.media || { photo: true, video: true, audio: true };
  const locationEnabled = tenant.form?.location?.enabled !== false;
  const mainFields = tenant.storySchema.fields.filter(f => (f.step || 'story') === 'story');
  const locFields = tenant.storySchema.fields.filter(f => f.step === 'location');
  const stepDefs = {
    story: { id: 'story', title: tenant.form?.steps?.story?.title || 'Your Story', sub: tenant.form?.steps?.story?.sub || '' },
    ...(Object.values(media).some(Boolean)
      ? { media: { id: 'media', title: tenant.form?.steps?.media?.title || 'Add Media', sub: tenant.form?.steps?.media?.sub || 'Photos, video, or voice — optional.' } }
      : {}),
    ...(locationEnabled
      ? { location: { id: 'location', title: tenant.form?.steps?.location?.title || 'Pin Location', sub: tenant.form?.steps?.location?.sub || 'Help us understand where this happened.' } }
      : {}),
    about: { id: 'about', title: tenant.form?.steps?.about?.title || 'You & Your Consent', sub: tenant.form?.steps?.about?.sub || 'Choose how your story appears. Contact info is optional and never public.' },
  };
  // Step order: config (validated at build time) beats the layout default
  // beats the classic order. Ids naming disabled steps are simply skipped;
  // consent ('about') always submits, so it stays last regardless.
  const order = (stepOrder || ['story', 'media', 'location', 'about']).filter(id => id !== 'about');
  const steps = [...order.map(id => stepDefs[id]).filter(Boolean), stepDefs.about];
  const TOTAL = steps.length;

  function resetState() {
    generation++;
    step = 1;
    answers = {};
    contact = { name: '', email: '', phone: '' };
    consent = 'anonymous';
    mediaFiles.forEach(m => { try { URL.revokeObjectURL(m.url); } catch { /* already gone */ } });
    mediaFiles = [];
    pendingLat = pendingLng = null;
    submitting = false;
    advancing = false;
    submissionId = null;
    clearTimeout(successTimer);
  }

  // Hard-stop the recorder WITHOUT keeping its blob — for the kiosk wipe, where
  // a late onstop must never push the previous participant's audio into the
  // next person's (freshly reset) mediaFiles.
  function discardRec() {
    clearInterval(recTimer);
    if (audioRec) {
      audioRec.onstop = null;
      try { if (audioRec.state !== 'inactive') audioRec.stop(); } catch { /* already stopped */ }
      try { audioRec.stream.getTracks().forEach(t => t.stop()); } catch { /* mic already released */ }
      audioRec = null;
    }
    isRec = false; recSecs = 0;
  }

  function open() {
    resetState();
    render();
    $('formOverlay').classList.add('open');
  }

  function close() {
    $('formOverlay').classList.remove('open');
    $('pinHint').classList.remove('show');
    stopRec();
    onClose?.();
  }

  /* Privacy wipe for kiosk handoffs: nothing from one participant — state,
     previews, typed contact info, recorded audio, or rendered DOM — survives
     to the next. discardRec() detaches the recorder so a late onstop can't
     resurrect the prior take; resetState() bumps `generation` so any submit()
     still awaiting a network call aborts instead of repainting this screen. */
  function wipe() {
    discardRec();
    resetState();
    $('fHead').innerHTML = '';
    $('fBody').innerHTML = '';
    $('fNav').innerHTML = '';
    $('formOverlay').classList.remove('open');
    $('pinHint').classList.remove('show');
  }

  function stepsDots() {
    return `<div class="steps mb8">${Array.from({ length: TOTAL }, (_, i) =>
      `<div class="step-d ${i + 1 < step ? 'done' : i + 1 === step ? 'now' : ''}"></div>`).join('')}</div>`;
  }

  function render() {
    const s = steps[step - 1];
    $('fHead').innerHTML = `<div class="sheet-head"><h2>${esc(s.title)}</h2><p>${esc(s.sub)}</p></div>`;
    const renderers = { story: renderStoryStep, media: renderMediaStep, location: renderLocationStep, about: renderAboutStep };
    renderers[s.id]();
    renderNav(s.id);
  }

  function renderNav(stepId) {
    const back = step > 1 ? `<button class="btn-bk" id="fBack">← Back</button>` : '';
    const next = stepId === 'about'
      ? `<button class="btn-nx" id="fNext">${esc(tenant.cta.submit)}</button>`
      : `<button class="btn-nx" id="fNext">Next →</button>`;
    $('fNav').innerHTML = back + next;
    $('fBack')?.addEventListener('click', () => { step--; render(); });
    $('fNext')?.addEventListener('click', () => (stepId === 'about' ? submit() : advance(stepId)));
  }

  async function advance(stepId) {
    if (advancing) return; // a double-tap must not skip a whole step
    if (stepId === 'story' && !validateStory()) return;
    advancing = true;
    try {
      if (isRec) await stopRec(); // leaving the media step finalizes & keeps the take
      step++;
      render();
    } finally {
      advancing = false;
    }
  }

  // ── step: story fields ────────────────────────────────────────
  function fieldHtml(f) {
    const v = answers[f.id];
    switch (f.kind) {
      case 'choice':
        return `<label class="flbl mb8">${esc(f.label)} ${f.required ? '<em>*</em>' : ''}</label>
          <div class="types">${(f.options || []).map(o => {
            const sel = v === o.id;
            return `<button type="button" class="tc ${sel ? 'sel' : ''}" data-field="${f.id}" data-opt="${o.id}"
              style="border-left:4px solid ${esc(o.color || 'var(--primary)')};border-color:${sel ? esc(o.color) : 'var(--border)'};background:${sel ? esc(o.tint || 'var(--primary-l)') : 'white'}">
              <span class="tc-ico">${o.emoji || ''}</span>
              <span class="tc-name" style="color:${sel ? esc(o.color) : 'var(--text)'}">${esc(o.label)}</span>
            </button>`;
          }).join('')}</div>`;
      case 'select-chips':
        return `<label class="flbl mb8">${esc(f.label)} ${f.required ? '<em>*</em>' : ''}</label>
          <div class="cat-grid">${(f.options || []).map(o =>
            `<button type="button" class="fcat ${v === o.id ? 'sel' : ''}" data-field="${f.id}" data-opt="${o.id}">
              ${o.emoji || ''} ${esc(o.label)}</button>`).join('')}</div>`;
      case 'select':
        return `<label class="flbl mb8">${esc(f.label)} ${f.required ? '<em>*</em>' : ''}</label>
          <select class="field mb8" data-input="${f.id}" style="height:44px">
            <option value="">${esc(f.placeholder || '— choose —')}</option>
            ${(f.options || []).map(o => `<option value="${o.id}" ${v === o.id ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
          </select>`;
      case 'longtext':
        return `<label class="flbl mb8">${esc(f.label)} ${f.required ? '<em>*</em>' : ''}</label>
          <textarea class="field mb8" data-input="${f.id}" rows="5" maxlength="${f.maxLength || 600}"
            placeholder="${esc(f.placeholder || '')}">${esc(v || '')}</textarea>
          <div class="chr" id="cc-${f.id}">${(v || '').length}/${f.maxLength || 600}</div>`;
      default: // shorttext
        return `<label class="flbl mb8">${esc(f.label)} ${f.required ? '<em>*</em>' : ''}</label>
          <input class="field mb12" data-input="${f.id}" placeholder="${esc(f.placeholder || '')}"
            value="${esc(v || '')}" style="height:44px">`;
    }
  }

  function bindFieldEvents(container) {
    container.querySelectorAll('[data-field]').forEach(el =>
      el.addEventListener('click', () => {
        answers[el.dataset.field] = el.dataset.opt;
        render();
      }));
    container.querySelectorAll('[data-input]').forEach(el =>
      el.addEventListener('input', () => {
        answers[el.dataset.input] = el.value;
        const cc = $(`cc-${el.dataset.input}`);
        if (cc) cc.textContent = `${el.value.length}/${el.getAttribute('maxlength')}`;
      }));
  }

  // Fun prompts: tappable sparks that reframe the long-text field's placeholder
  // without touching what the person has written. Shown once, above the fields.
  // A tenant whose story step already asks the prompts (a choice field built
  // from the same pack) sets form.sparkChips: false so they don't repeat.
  const prompts = tenant.form?.sparkChips === false ? [] : promptPack(tenant);
  const longField = mainFields.find(f => f.kind === 'longtext');
  function sparkHtml() {
    if (!prompts.length || !longField) return '';
    return `<div class="sparks" id="sparks">
      <span class="sparks-lbl">${esc(tenant.form?.promptLabel || 'Need a spark?')}</span>
      <div class="sparks-row">${prompts.map((p, i) =>
        `<button type="button" class="spark" data-spark="${i}">${esc((p.emoji ? p.emoji + ' ' : '') + p.text)}</button>`).join('')}</div>
    </div>`;
  }

  function renderStoryStep() {
    $('fBody').innerHTML = `${stepsDots()}
      <div class="err-msg" id="errStory"></div>
      ${sparkHtml()}
      ${mainFields.map(fieldHtml).join('')}`;
    bindFieldEvents($('fBody'));
    $('fBody').querySelectorAll('[data-spark]').forEach(el =>
      el.addEventListener('click', () => {
        const p = prompts[+el.dataset.spark];
        const ta = $('fBody').querySelector(`[data-input="${longField.id}"]`);
        if (ta) { ta.setAttribute('placeholder', p.text); ta.focus(); }
        $('fBody').querySelectorAll('.spark').forEach(s => s.classList.remove('on'));
        el.classList.add('on');
      }));
  }

  function validateStory() {
    for (const f of mainFields) {
      if (f.required && !(answers[f.id] || '').toString().trim()) {
        const err = $('errStory');
        err.textContent = f.kind === 'choice' || f.kind === 'select-chips' || f.kind === 'select'
          ? `Please choose: ${f.label}` : `Please fill in: ${f.label}`;
        err.classList.add('show');
        return false;
      }
    }
    $('errStory')?.classList.remove('show');
    return true;
  }

  // ── step: media ───────────────────────────────────────────────
  const fmt = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const audioMF = () => mediaFiles.filter(f => f.kind === 'audio');

  function renderMediaStep() {
    const kinds = ['photo', 'video', 'audio'].filter(k => media[k]);
    const active = kinds.find(k => $(`mp-${k}`)?.classList.contains('on')) || kinds[0];
    $('fBody').innerHTML = `${stepsDots()}
      <div class="mtabs">${kinds.map(k => `
        <button type="button" class="mtab ${k === active ? 'on' : ''}" id="mt-${k}" data-mtab="${k}">
          ${{ photo: icon('camera', 16), video: icon('video', 16), audio: icon('mic', 16) }[k]}<span>${{ photo: 'Photo', video: 'Video', audio: 'Voice' }[k]}</span>
        </button>`).join('')}</div>
      ${media.photo ? `
      <div class="mpanel ${active === 'photo' ? 'on' : ''}" id="mp-photo">
        <div class="upload-z" id="photoZone">
          <span class="uz-ico">${icon('image', 28)}</span><span class="uz-lbl">Add photos</span>
          <span class="uz-sub">Browse files or drag &amp; drop</span>
          <button type="button" class="uz-cam" id="camBtn">${icon('camera')} Open Camera</button>
        </div>
        <input type="file" id="pi" accept="image/*" multiple hidden>
        <input type="file" id="ci" accept="image/*" capture="environment" hidden>
        <div class="prevs" id="pp">${mkPrevs('photo')}</div>
      </div>` : ''}
      ${media.video ? `
      <div class="mpanel ${active === 'video' ? 'on' : ''}" id="mp-video">
        <div class="upload-z" id="videoZone">
          <span class="uz-ico">${icon('video', 28)}</span><span class="uz-lbl">Add a video</span>
          <span class="uz-sub">Upload from your device</span>
        </div>
        <input type="file" id="vi" accept="video/*" hidden>
        <div class="prevs" id="vp">${mkPrevs('video')}</div>
      </div>` : ''}
      ${media.audio ? `
      <div class="mpanel ${active === 'audio' ? 'on' : ''}" id="mp-audio">
        <div class="rec-area">
          <button type="button" class="rec-btn ${isRec ? 'recording' : ''}" id="recBtn">${isRec ? icon('stop', 26) : icon('mic', 26)}</button>
          <div class="rec-timer" id="rt">${fmt(recSecs)}</div>
          <div class="rec-status">${isRec ? 'Recording… tap to stop' : 'Tap to record your voice'}</div>
          ${audioMF().length ? `<audio controls src="${audioMF()[0].url}" style="width:100%;margin-top:10px;border-radius:8px"></audio>
            <button type="button" class="rec-retry" id="clearAudioBtn">✕ Record again</button>` : ''}
        </div>
        <div style="text-align:center;margin-top:8px">
          <span style="font-size:.62rem;color:var(--muted)">— or upload an audio file —</span><br>
          <input type="file" id="ai" accept="audio/*" hidden>
          <button type="button" id="aiBtn" style="margin-top:6px;font-size:.68rem;color:var(--primary);background:none;cursor:pointer;text-decoration:underline">Upload audio</button>
        </div>
      </div>` : ''}`;

    // events
    $('fBody').querySelectorAll('[data-mtab]').forEach(b =>
      b.addEventListener('click', () => {
        kinds.forEach(k => {
          $(`mt-${k}`)?.classList.toggle('on', k === b.dataset.mtab);
          $(`mp-${k}`)?.classList.toggle('on', k === b.dataset.mtab);
        });
      }));
    const zone = $('photoZone');
    if (zone) {
      zone.addEventListener('click', e => { if (e.target.id !== 'camBtn') $('pi').click(); });
      zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
      zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag-over'); addFiles(e.dataTransfer.files, 'photo'); });
      $('camBtn').addEventListener('click', () => $('ci').click());
      $('pi').addEventListener('change', e => addFiles(e.target.files, 'photo'));
      $('ci').addEventListener('change', e => addFiles(e.target.files, 'photo'));
    }
    $('videoZone')?.addEventListener('click', () => $('vi').click());
    $('vi')?.addEventListener('change', e => addFiles(e.target.files, 'video'));
    $('recBtn')?.addEventListener('click', toggleRec);
    $('clearAudioBtn')?.addEventListener('click', () => { mediaFiles = mediaFiles.filter(f => f.kind !== 'audio'); render(); });
    $('aiBtn')?.addEventListener('click', () => $('ai').click());
    $('ai')?.addEventListener('change', e => addFiles(e.target.files, 'audio'));
    bindPreviewRemoval();
  }

  function addFiles(files, kind) {
    Array.from(files).forEach(file => {
      if (kind === 'audio') mediaFiles = mediaFiles.filter(f => f.kind !== 'audio');
      mediaFiles.push({ kind, file, url: URL.createObjectURL(file) });
    });
    const pid = kind === 'photo' ? 'pp' : kind === 'video' ? 'vp' : null;
    if (pid && $(pid)) { $(pid).innerHTML = mkPrevs(kind); bindPreviewRemoval(); }
    if (kind === 'audio') render();
  }

  function mkPrevs(kind) {
    return mediaFiles.filter(f => f.kind === kind).map((f, i) => `
      <div class="pw">
        ${f.kind === 'photo'
          ? `<img class="p-img" src="${f.url}">`
          : f.kind === 'video'
            ? `<video class="p-vid" src="${f.url}" muted></video>`
            : `<div style="width:68px;height:68px;border-radius:7px;background:var(--bg);display:flex;align-items:center;justify-content:center;font-size:1.4rem;border:1px solid var(--border)">${icon('mic', 24)}</div>`}
        <div class="p-rm" data-rm="${i}" data-rmkind="${kind}">✕</div>
      </div>`).join('');
  }

  function bindPreviewRemoval() {
    $('fBody').querySelectorAll('[data-rm]').forEach(el =>
      el.addEventListener('click', () => {
        const kf = mediaFiles.filter(f => f.kind === el.dataset.rmkind);
        mediaFiles = mediaFiles.filter(f => f !== kf[+el.dataset.rm]);
        const pid = el.dataset.rmkind === 'photo' ? 'pp' : 'vp';
        if ($(pid)) { $(pid).innerHTML = mkPrevs(el.dataset.rmkind); bindPreviewRemoval(); }
      }));
  }

  let recFinalized = null; // resolves when the current recording's blob is stored
  async function toggleRec() {
    if (isRec) { await stopRec(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];
      // Let the browser pick a supported container (Safari/iOS produce mp4/aac,
      // not webm) and label the blob + upload accordingly.
      audioRec = new MediaRecorder(stream);
      recFinalized = new Promise(resolve => {
        audioRec.ondataavailable = e => { if (e.data.size) audioChunks.push(e.data); };
        audioRec.onstop = () => {
          stream.getTracks().forEach(t => t.stop());
          const type = audioRec.mimeType || 'audio/webm';
          const ext = /mp4|aac/.test(type) ? 'mp4' : /ogg/.test(type) ? 'ogg' : 'webm';
          const blob = new Blob(audioChunks, { type });
          const file = new File([blob], `voice.${ext}`, { type });
          mediaFiles = mediaFiles.filter(f => f.kind !== 'audio');
          mediaFiles.push({ kind: 'audio', file, url: URL.createObjectURL(blob) });
          isRec = false; recSecs = 0; clearInterval(recTimer);
          render();
          resolve();
        };
      });
      audioRec.start();
      isRec = true; recSecs = 0;
      recTimer = setInterval(() => {
        recSecs++;
        const t = $('rt');
        if (t) t.textContent = fmt(recSecs);
      }, 1000);
      render();
    } catch {
      alert('Microphone access denied.');
    }
  }

  // Returns a promise that resolves once any in-flight recording is captured.
  async function stopRec() {
    if (audioRec && isRec) { audioRec.stop(); isRec = false; await recFinalized; }
    clearInterval(recTimer);
  }

  // ── step: location ────────────────────────────────────────────
  function renderLocationStep() {
    $('fBody').innerHTML = `${stepsDots()}
      <label class="flbl mb8">${esc(tenant.form?.location?.label || 'Where did this happen?')}</label>
      <span class="fhint">${esc(tenant.form?.location?.hint || 'Optional.')}</span>
      <div class="loc-opts">
        <button type="button" class="loc-btn" id="pinBtn">
          <span class="loc-ico">${icon('pin', 22)}</span><span class="loc-name">Drop a Pin</span>
          <span class="loc-sub">Tap map to place</span>
        </button>
        <button type="button" class="loc-btn" id="gpsBtn">
          <span class="loc-ico">${icon('gps', 22)}</span><span class="loc-name">My Location</span>
          <span class="loc-sub">Use GPS</span>
        </button>
      </div>
      <div class="loc-st ${pendingLat ? 'ok' : ''}" id="locSt">
        ${pendingLat ? '✓ Location set' : 'No location — you can skip this step'}
      </div>
      <div style="margin-top:12px">${locFields.map(fieldHtml).join('')}</div>`;
    bindFieldEvents($('fBody'));
    $('pinBtn').addEventListener('click', () => {
      $('pinHint').classList.add('show');
      $('formOverlay').classList.remove('open');
      onRequestPin?.();
    });
    $('gpsBtn').addEventListener('click', useGPS);
  }

  function setPinLocation(lat, lng) {
    pendingLat = lat;
    pendingLng = lng;
    $('pinHint').classList.remove('show');
    $('formOverlay').classList.add('open');
    render();
  }

  function useGPS() {
    const st = $('locSt');
    st.textContent = 'Getting your location...';
    st.className = 'loc-st';
    if (!navigator.geolocation) { st.className = 'loc-st err'; st.textContent = 'GPS not available'; return; }
    navigator.geolocation.getCurrentPosition(
      p => {
        pendingLat = p.coords.latitude;
        pendingLng = p.coords.longitude;
        st.className = 'loc-st ok';
        st.textContent = '✓ Location set via GPS';
      },
      () => { st.className = 'loc-st err'; st.textContent = 'Could not get location. Try dropping a pin.'; },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  // ── step: about you + consent ─────────────────────────────────
  function renderAboutStep() {
    const levels = consentLevels(tenant);
    $('fBody').innerHTML = `${stepsDots()}
      <div class="err-msg" id="errAbout"></div>
      <label class="flbl mb8">${esc(tenant.consent?.question || 'How should your story appear?')} <em>*</em></label>
      ${tenant.consent?.explainer ? `<span class="fhint" style="margin-bottom:8px">${esc(tenant.consent.explainer)}</span>` : ''}
      <div class="consent-list mb12">${levels.map(l => `
        <label class="consent-opt ${consent === l.id ? 'sel' : ''}" data-consent="${l.id}">
          <input type="radio" name="consent" value="${l.id}" ${consent === l.id ? 'checked' : ''}>
          <span class="consent-ico">${l.emoji}</span>
          <span class="consent-body">
            <span class="consent-label">${esc(l.label)}</span>
            <span class="consent-desc">${esc(l.desc)}</span>
          </span>
        </label>`).join('')}</div>
      <div id="nameWrap" style="display:${consentNeedsName(consent) ? 'block' : 'none'}">
        <label class="flbl mb8">Your name <em>*</em></label>
        <input class="field mb12" id="nm" placeholder="${consent === 'first_name' ? 'Only first name + initial will show' : 'Shown with your story'}"
          value="${esc(contact.name)}" style="height:44px">
      </div>
      <label class="flbl mb8">Email address</label>
      <span class="fhint">${esc(tenant.form?.contactHint || `Only so ${tenant.org?.name || 'the organizing team'} can follow up. Never shared publicly.`)}</span>
      <input class="field mb12" id="em" type="email" placeholder="Optional" value="${esc(contact.email)}" style="height:44px">
      <label class="flbl mb8">Phone number</label>
      <input class="field mb12" id="ph" type="tel" placeholder="Optional" value="${esc(contact.phone)}" style="height:44px">
      <p style="font-size:.68rem;color:var(--muted);line-height:1.5;margin-top:4px">${esc(tenant.consent?.agreement || 'By submitting, you agree your story may appear on this public map according to the visibility you chose above. You can request removal at any time.')}</p>`;

    $('fBody').querySelectorAll('[data-consent]').forEach(el =>
      el.addEventListener('click', () => {
        contact.name = $('nm')?.value ?? contact.name;
        contact.email = $('em')?.value ?? contact.email;
        contact.phone = $('ph')?.value ?? contact.phone;
        consent = el.dataset.consent;
        renderAboutStep();
      }));
    ['nm', 'em', 'ph'].forEach(id =>
      $(id)?.addEventListener('input', e => {
        contact[{ nm: 'name', em: 'email', ph: 'phone' }[id]] = e.target.value;
      }));
  }

  // ── submit ────────────────────────────────────────────────────
  function showError(text) {
    const err = $('errAbout');
    err.innerHTML = esc(text);
    err.classList.add('show');
  }

  function restoreSubmitBtn() {
    submitting = false;
    const btn = $('fNext');
    if (btn) { btn.disabled = false; btn.textContent = tenant.cta.submit; }
  }

  /* One upload failed. Be honest and keep the resident in control: retry the
     upload, or send the story without that file — never a dead end. */
  function mediaFailure(m) {
    restoreSubmitBtn();
    const err = $('errAbout');
    err.innerHTML = `${esc(`Your ${m.kind} couldn’t be uploaded. Your story is still here — you can try again or send it without the ${m.kind}.`)}
      <div class="err-actions">
        <button type="button" class="err-btn" id="errRetry">Try again</button>
        <button type="button" class="err-btn ghost" id="errDrop">Send without ${esc(m.kind)}</button>
      </div>`;
    err.classList.add('show');
    $('errRetry').addEventListener('click', () => { err.classList.remove('show'); submit(); });
    $('errDrop').addEventListener('click', () => {
      mediaFiles = mediaFiles.filter(f => f !== m);
      err.classList.remove('show');
      submit();
    });
  }

  async function submit() {
    if (submitting) return;
    await stopRec(); // capture any recording still running, and release the mic
    if (consentNeedsName(consent) && !contact.name.trim()) {
      showError('Please enter your name, or choose Anonymous.');
      return;
    }
    submitting = true;
    submissionId ||= crypto.randomUUID();
    const gen = generation; // if a kiosk wipe bumps this mid-submit, bail out
    const btn = $('fNext');
    btn.disabled = true;
    btn.textContent = 'Submitting...';

    // Uploads first, one at a time; already-uploaded files are not re-sent on
    // a retry, so a second attempt only redoes what actually failed.
    const uploaded = [];
    for (const m of mediaFiles) {
      if (!m.remote) {
        btn.textContent = `Uploading ${m.kind}...`;
        try {
          m.remote = await api.uploadMedia(m.file, m.kind);
        } catch (e) {
          if (gen !== generation) return;
          console.error(e);
          mediaFailure(m);
          return;
        }
      }
      if (gen !== generation) return; // wiped mid-upload — abandon this submit
      uploaded.push(m.remote);
    }

    try {
      let turnstileToken = null;
      if (platform?.turnstile?.siteKey) {
        btn.textContent = 'One moment…';
        turnstileToken = await getTurnstileToken(platform.turnstile.siteKey, tsBox());
      }
      if (gen !== generation) return;
      btn.textContent = 'Submitting...';
      const locationField = locFields[0];
      await onSubmit({
        id: submissionId,
        consentLevel: consent,
        displayName: computeDisplayName(consent, contact.name),
        answers,
        lat: pendingLat,
        lng: pendingLng,
        locationLabel: locationField ? answers[locationField.id] || null : null,
        media: uploaded,
        source,
        turnstileToken,
        contact: {
          full_name: contact.name.trim() || null,
          email: contact.email.trim() || null,
          phone: contact.phone.trim() || null,
        },
      });
      if (gen !== generation) return; // participant walked away; don't repaint
      showSuccess();
    } catch (e) {
      if (gen !== generation) return;
      console.error(e);
      restoreSubmitBtn();
      showError(explainSubmitError(e).text);
    }
  }

  // Turnstile needs a live element to render into; the about step is the only
  // place a challenge could ever appear, right above the submit button.
  function tsBox() {
    let box = $('tsBox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'tsBox';
      box.className = 'ts-box';
      $('fBody').appendChild(box);
    }
    return box;
  }

  function showSuccess() {
    const ref = submissionId.slice(-6).toUpperCase();
    const kiosk = mode === 'kiosk';
    $('fHead').innerHTML = '';
    $('fBody').innerHTML = `
      <div class="success-wrap">
        <span class="s-ico">${icon('check', 44)}</span>
        <h3>${esc(tenant.cta.successTitle || 'Story submitted!')}</h3>
        <p>${esc(tenant.cta.successBody || 'Thank you for sharing. The team will review your story before it appears publicly.')}</p>
        <p class="s-ref">Your story reference: <strong>#${ref}</strong></p>
        ${contact.email && !kiosk ? `<p style="margin-top:10px;font-size:.72rem;color:var(--muted)">We'll be in touch at <strong>${esc(contact.email)}</strong> if needed.</p>` : ''}
        ${kiosk ? `<p class="s-handoff">Please hand the device back — this screen clears itself for the next person.</p>` : ''}
      </div>`;
    $('fNav').innerHTML = `<button class="btn-nx" id="fDone">Done</button>`;
    $('fDone').addEventListener('click', () => { close(); onDone?.(); });
    if (kiosk) {
      // Never leave a finished submission (with a visible email) on screen.
      successTimer = setTimeout(() => { close(); onDone?.(); }, 30_000);
    }
  }

  return { open, close, wipe, setPinLocation, get pending() { return { lat: pendingLat, lng: pendingLng }; } };
}
