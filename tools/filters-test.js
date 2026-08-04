#!/usr/bin/env node
/* Output comparison for the filter layer of app.html.  DECISIONS D32.
 *
 *   node tools/filters-test.js <baseline.html> <candidate.html>
 *
 * The gap D32 names is that every check written on 2026-08-04 lived in a browser console
 * and none of it was saved, so nothing could be re-run.  This is the first one saved.
 *
 * It does NOT read the diff.  It loads the filter code out of BOTH files, drives the two
 * copies through the same states, and compares what each one produces:
 *
 *   1. passes()            every seed story, against 576 filter states
 *   2. activeFilterCount() the number on the Filters toggle, same 576 states
 *   3. renderSelects()     the <option> markup of all three dropdowns, character for
 *                          character, same 576 states
 *   4. renderActiveF()     the active-filter row markup, same 576 states
 *   5. syncUrl()           the query string a state produces, same 576 states
 *   6. the boot block      the filter state a URL produces, over 40 hand-written links
 *                          including junk values that must be rejected
 *
 * How it loads them: the script is sliced rather than run whole, because running it whole
 * needs Leaflet, Mapbox and a DOM.  Everything from the top of the script down to the end
 * of the filter section is taken verbatim, then four functions and the boot block are cut
 * out of the later sections by brace matching and appended.  Nothing is retyped, so this
 * cannot drift from the file it is checking; if a function is renamed, the cut fails loudly
 * rather than silently comparing nothing.
 *
 * EXPECTED_DIFFS is the deliberate part.  A behaviour change is declared here as an exact
 * string, and anything that differs and is NOT declared fails the run.  "Nothing changed"
 * and "these four things changed, on purpose" are both provable; drift is not.
 */
'use strict';
const fs = require('fs');

/* ---- the deliberate behaviour changes in the change you are making now --------------
   Empty means "this must change nothing", which is what a refactor should assert.

   Add an entry only for a difference you MEANT, and CLEAR THEM AGAIN once that change
   is merged. A stale entry is worse than no test: it goes on quietly swallowing exactly
   the difference it was written to allow, so the regression it later hides is the one
   nobody is watching for.

   Each entry: `check` is the check name it applies to (a bare name, or a prefix before
   a dot); `match` is a regex tested against the old and new values; `state` is a regex
   tested against the filter state or link the difference happened in; `why` is what gets
   printed. Whichever of `match` and `state` you give must both hold, so `state` is how
   you say "only excuse this where the story filter is actually on" instead of excusing
   every difference that happens to contain the same word. Anything that differs and is
   not excused fails the run.

   For reference, the entries used for the STORY-69 filter registry were:

     {check:'syncUrl',       why:'place and campaign are shareable now',
      match:/(^|&)(place|collected)=/},
     {check:'bootParam',     why:'place and campaign are readable now',
      match:/\b(place|campaign)\b/},
     {check:'renderActiveF', why:'Clear All appears for campaign and dc too',
      match:/clearf/},
*/
const EXPECTED_DIFFS = [
  // STORY-71: `story` joined the registry, so a story is linkable.
  {check: 'syncUrl',       why: 'a story is linkable now',
   match: /(^|&)story=/,      state: /"story":"[^"]/},
  {check: 'bootParam',     why: '?story= is read back now',
   match: /"story":"[^"]/,    state: /story=/},
  {check: 'renderActiveF', why: 'Clear All appears while a story is open',
   match: /clearf/,           state: /"story":"[^"]/},
];

/* ---- slicing ---------------------------------------------------------------------- */
function scriptOf(path) {
  const s = fs.readFileSync(path, 'utf8');
  const a = s.indexOf('<script>\n"use strict"');
  if (a < 0) throw new Error(path + ': no <script> with "use strict"');
  return s.slice(a + 8, s.lastIndexOf('</script>'));
}

/* Everything up to the map section: constants, seeds, the story store, and the filter
   section itself, whichever name it goes by. */
function head(js, path) {
  const end = js.indexOf('/* === JS SECTION: MAP: TOKEN AND BASE TILES');
  if (end < 0) throw new Error(path + ': cannot find the MAP: TOKEN AND BASE TILES anchor');
  return js.slice(0, end);
}

/* Cut one `function name(...){...}` out by matching braces.  Strings and comments in
   these particular functions never contain an unbalanced brace; if that ever changes
   this throws rather than returning half a function. */
function fn(js, name, path) {
  const start = js.indexOf('function ' + name + '(');
  if (start < 0) throw new Error(path + ': function ' + name + ' not found');
  let i = js.indexOf('{', start), depth = 0;
  for (; i < js.length; i++) {
    if (js[i] === '{') depth++;
    else if (js[i] === '}' && --depth === 0) return js.slice(start, i + 1);
  }
  throw new Error(path + ': function ' + name + ' never closes');
}

/* The boot block is an anonymous IIFE, found by the comment above it. */
function bootBlock(js, path) {
  const anchor = 'A shared link arrives as filter state';
  const at = js.indexOf(anchor);
  if (at < 0) throw new Error(path + ': cannot find the boot block');
  const start = js.indexOf('(function(){', at);
  let i = js.indexOf('{', start), depth = 0;
  for (; i < js.length; i++) {
    if (js[i] === '{') depth++;
    else if (js[i] === '}' && --depth === 0) return js.slice(start, i + 1) + ')();';
  }
  throw new Error(path + ': boot block never closes');
}

/* ---- the stub the sliced code runs against ----------------------------------------
   The slice defines its own $() over document.getElementById, so the stub goes in at
   that level rather than replacing $.  Every id returns the same recorder, so whatever
   a render function assigns to innerHTML is captured by id and compared as a string. */
function build(path) {
  const js = scriptOf(path);
  const src =
    head(js, path) +
    // passes() reaches forward into the map section for these three.
    '\n;var SITE_R=110;' + fn(js, 'metresApart', path) + fn(js, 'siteNameFor', path) +
    '\n;' + fn(js, 'renderSelects', path) +
    '\n;' + fn(js, 'renderActiveF', path) +
    '\n;' + fn(js, 'renderFCount', path) +
    '\n;' + fn(js, 'activeFilterCount', path) +
    '\n;' + fn(js, 'syncUrl', path) +
    '\n;function __boot(){var params=new URLSearchParams(location.search);' + bootBlock(js, path) + '}' +
    // cultural.geojson loads over the network, so the harness supplies two sites, one of
    // them on a seed story, or the site filter would match nothing and prove nothing.
    '\n;CULTURAL=[{properties:{name:"Clayborn Temple"},geometry:{coordinates:[-90.0511,35.1365]}},' +
    '{properties:{name:"Stax"},geometry:{coordinates:[-90.0292,35.1148]}}];' +
    '\n;return {get F(){return F;},set F(v){F=v;},passes:passes,filters:FILTERS,' +
    'renderSelects:renderSelects,renderActiveF:renderActiveF,' +
    'activeFilterCount:activeFilterCount,syncUrl:syncUrl,boot:__boot,' +
    'stories:function(){return STORIES;}};';

  const html = {}, vals = {};                        // id -> last innerHTML / value written
  const el = id => ({
    get innerHTML() { return html[id] || ''; },
    set innerHTML(v) { html[id] = v; },
    get value() { return vals[id] || ''; },
    set value(v) { vals[id] = v; },
    querySelectorAll: () => [],
    addEventListener: () => {},
    setAttribute: () => {},
    textContent: '', hidden: false,
  });
  const cache = {};
  const $ = id => (cache[id] || (cache[id] = el(id)));

  const loc = {search: '', pathname: '/app.html', hash: ''};
  let lastUrl = '';
  const sandbox = {
    location: loc, URLSearchParams,
    history: {replaceState: (a, b, url) => { lastUrl = url; }},
    document: {getElementById: $, querySelectorAll: () => [], addEventListener: () => {}},
    localStorage: {getItem: () => null, setItem: () => {}},
    sessionStorage: {getItem: () => null, setItem: () => {}},
    console: {warn: () => {}, log: () => {}},
    fetch: () => Promise.reject(new Error('no network in the harness')),
  };
  const keys = Object.keys(sandbox);
  const api = new Function(...keys, src)(...keys.map(k => sandbox[k]));

  api.html = html;
  api.vals = vals;
  api.setSearch = q => { loc.search = q; };
  api.lastUrl = () => lastUrl;
  api.params = () => { const p = new URLSearchParams(lastUrl.split('?')[1] || ''); p.sort(); return p.toString(); };
  return api;
}

/* ---- the state matrix -------------------------------------------------------------- */
const AXES = {
  kinds: [[], ['memory'], ['memory', 'future']],
  hood: ['all', 'Soulsville', 'Nowhere At All'],
  era: ['all', 'civilrights'],
  campaign: ['all', 'porch'],
  place: [null, 'church'],
  site: [null, 'Clayborn Temple'],
  dc: [null, 'colossus1'],
  story: [null, 's3'],
  q: ['', 'the'],
};
function states() {
  let out = [{}];
  for (const k of Object.keys(AXES)) {
    const next = [];
    for (const base of out) for (const v of AXES[k]) next.push(Object.assign({}, base, {[k]: v}));
    out = next;
  }
  return out;
}
const applyState = (api, st) => {
  api.F = Object.assign({}, st, {kinds: new Set(st.kinds)});
};

/* The matrix has to keep up with the registry or this whole file quietly stops covering
   things: a filter nobody added an axis for is simply never switched on, every check
   passes, and the run still says PASS. So ask the candidate what filters it has. */
function checkCoverage(api) {
  const declared = (api.filters || []).map(f => f.key);
  if (!declared.length) return ['could not read FILTERS out of the candidate'];
  const gaps = declared.filter(k => !(k in AXES));
  const stale = Object.keys(AXES).filter(k => !declared.includes(k));
  return [
    ...gaps.map(k => `FILTERS declares "${k}" but AXES has no values for it, so it is never tested. Add one.`),
    ...stale.map(k => `AXES tests "${k}" but FILTERS no longer declares it. Remove it.`),
  ];
}

const LINKS = [
  '', '?hood=Soulsville', '?hood=', '?hood=Nowhere',
  '?site=Clayborn%20Temple', '?site=', '?dc=colossus1', '?dc=',
  '?type=memory', '?type=future', '?type=nonsense', '?type=',
  '?era=civilrights', '?era=future2065', '?era=nonsense', '?era=',
  '?q=blues', '?q=', '?place=church', '?place=nonsense',
  '?collected=porch', '?collected=nonsense',
  '?hood=Soulsville&era=civilrights&type=memory&q=blues',
  '?hood=Soulsville&site=Clayborn%20Temple&dc=colossus1',
  '?mode=kiosk&kind=future&campaign=juneteenth&event=main',
  '?campaign=juneteenth', '?campaign=juneteenth&hood=Soulsville',
  '?mode=admin', '?mode=share&kind=memory', '?unrelated=1&hood=Midtown',
  '?era=today&collected=web&place=music&type=culture',
  '?hood=Soulsville&hood=Midtown', '?q=%22quoted%22', '?q=a%26b',
  '?type=memory&type=future', '?place=street&site=Clayborn%20Temple',
  '?q=the+blues', '?era=tomorrow', '?hood=Downtown%20%2F%20Clayborn', '?dc=nonexistent',
  '?story=s3', '?story=', '?story=nonexistent', '?story=s3&hood=Soulsville',
  '?mode=admin&story=s3', '?story=s1&type=culture&era=civilrights',
];

/* ---- run ---------------------------------------------------------------------------- */
const VERBOSE = process.argv.includes('--verbose');
const [basePath, candPath] = process.argv.slice(2).filter(a => a !== '--verbose');
if (!basePath || !candPath) {
  console.error('usage: filters-test.js <baseline.html> <candidate.html>');
  process.exit(2);
}
const A = build(basePath), B = build(candPath);

const fails = [], allowed = [];
let compared = 0;
function cmp(check, label, a, b) {
  compared++;
  if (a === b) return;
  const line = check + '  ' + label + '\n    baseline : ' + a + '\n    candidate: ' + b;
  const ok = EXPECTED_DIFFS.find(d =>
    (d.check === check || check.indexOf(d.check + '.') === 0) &&
    (!d.match || d.match.test(String(a)) || d.match.test(String(b))) &&
    (!d.state || d.state.test(String(label))));
  (ok ? allowed : fails).push(ok ? {line, why: ok.why} : line);
}

const coverageGaps = checkCoverage(B);
if (coverageGaps.length) {
  console.error('FAIL  the matrix no longer covers the registry:');
  coverageGaps.forEach(g => console.error('  ' + g));
  process.exit(1);
}

const stories = A.stories();
if (!stories.length) { console.error('FAIL  no seed stories in the baseline, nothing to filter'); process.exit(1); }
if (JSON.stringify(stories) !== JSON.stringify(B.stories())) {
  console.error('FAIL  the two files carry different seed stories; passes() is not comparable');
  process.exit(1);
}

for (const st of states()) {
  const tag = JSON.stringify(st);
  applyState(A, st); applyState(B, st);

  // 1. which stories survive
  cmp('passes', tag, stories.map(s => (A.passes(s) ? 1 : 0)).join(''),
                     stories.map(s => (B.passes(s) ? 1 : 0)).join(''));

  // 2. the badge
  cmp('activeFilterCount', tag, A.activeFilterCount(), B.activeFilterCount());

  // 3. the dropdowns, character for character
  A.renderSelects(); B.renderSelects();
  for (const id of ['hoodSel', 'eraSel', 'campSel']) cmp('renderSelects.' + id, tag, A.html[id], B.html[id]);

  // 4. the active-filter row
  A.renderActiveF(); B.renderActiveF();
  cmp('renderActiveF', tag, A.html.activeF, B.html.activeF);

  // 5. the shareable link
  A.setSearch(''); B.setSearch('');
  A.syncUrl(); B.syncUrl();
  cmp('syncUrl', tag, A.params(), B.params());
}

// 5b. syncUrl must leave parameters it does not own alone, whatever the state
for (const st of states().slice(0, 64)) {
  applyState(A, st); applyState(B, st);
  A.setSearch('?mode=kiosk&campaign=juneteenth&event=main&kind=future');
  B.setSearch('?mode=kiosk&campaign=juneteenth&event=main&kind=future');
  A.syncUrl(); B.syncUrl();
  cmp('syncUrl.keepsOthers', JSON.stringify(st), A.params(), B.params());
  for (const must of ['mode=kiosk', 'campaign=juneteenth', 'event=main', 'kind=future']) {
    compared++;
    if (B.params().indexOf(must) < 0)
      fails.push('syncUrl.keepsOthers  ' + JSON.stringify(st) + '\n    candidate dropped ' + must + ' from ' + B.params());
  }
}

// 6. a link in, filter state out
/* The whole filter state, keyed off the candidate's own registry rather than a list
   written out by hand here. That list had already gone stale once: `story` was added to
   the registry and to AXES, and this function still did not mention it, so the boot check
   compared two shapes neither of which contained the new filter and reported no
   difference. It looked like a pass. Anything the baseline does not have reads as null,
   which is what makes "the old one could not do this" show up as a difference. */
const SHAPE_KEYS = (B.filters || []).map(f => ({key: f.key, type: f.type}));
const shape = api => {
  const F = api.F, out = {};
  SHAPE_KEYS.forEach(({key, type}) => {
    const v = F[key];
    out[key] = type === 'set' ? Array.from(v || []).sort() : (v === undefined ? null : v);
  });
  out.searchBox = api.vals.searchIn || '';
  return JSON.stringify(out);
};
/* The cleared state, also from the registry, for the same reason. */
const blankF = () => {
  const o = {};
  SHAPE_KEYS.forEach(({key, type}) => {
    o[key] = type === 'set' ? new Set() : type === 'select' ? 'all' : type === 'text' ? '' : null;
  });
  return o;
};
for (const link of LINKS) {
  A.F = blankF();
  B.F = blankF();
  A.vals.searchIn = ''; B.vals.searchIn = '';
  A.setSearch(link); B.setSearch(link);
  A.boot(); B.boot();
  cmp('bootParam', link || '(no query)', shape(A), shape(B));
}

// 7. every state the boot block can produce must survive a round trip back to a URL
let roundTrips = 0;
for (const link of LINKS) {
  B.F = blankF();
  B.vals.searchIn = '';
  B.setSearch(link); B.boot();
  const first = shape(B);
  B.setSearch(''); B.syncUrl();
  const url = '?' + B.params();
  B.F = blankF();
  B.vals.searchIn = '';
  B.setSearch(url); B.boot();
  roundTrips++; compared++;
  if (shape(B) !== first)
    fails.push('roundTrip  ' + (link || '(no query)') + '\n    after boot : ' + first + '\n    after url  : ' + shape(B) + '  (' + url + ')');
}

/* ---- report -------------------------------------------------------------------------- */
console.log('compared ' + compared + ' outputs across ' + states().length + ' filter states, ' +
            LINKS.length + ' links and ' + roundTrips + ' round trips');
if (allowed.length) {
  const by = {};
  allowed.forEach(a => { (by[a.why] = by[a.why] || []).push(a.line); });
  console.log('\ndeliberate differences, declared in EXPECTED_DIFFS:');
  for (const why of Object.keys(by)) {
    console.log('  ' + by[why].length + '  ' + why);
    if (VERBOSE) by[why].forEach(l => console.log('      ' + l.replace(/\n/g, '\n      ')));
  }
}
if (fails.length) {
  console.log('\nUNDECLARED DIFFERENCES (' + fails.length + '), first 12:');
  fails.slice(0, 12).forEach(f => console.log('  ' + f));
  process.exit(1);
}
console.log('\nPASS  no undeclared difference');
