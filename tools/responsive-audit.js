#!/usr/bin/env node
/* responsive-audit.js — measure app.html at real device widths.
 *
 * WHY THIS EXISTS
 * The responsive audit that produced STORY-88..93 was done by hand in fixed-width
 * frames and written into a Linear issue. That is not re-runnable, so the next layout
 * edit cannot be checked against it. This is that audit as a file.
 *
 * It answers, per width, the four questions the issues are actually about:
 *   1. how much of the story panel is chrome before a story shows   (STORY-89)
 *   2. does the nav fit, and if not does anything say so            (STORY-90)
 *   3. which layout is in force                                     (STORY-91)
 *   4. how much of the screen the Map Layers panel takes            (STORY-92)
 *   5. how many interactive things are under 44px                   (STORY-93)
 *
 * NO DEPENDENCIES ON PURPOSE. It drives the Chrome already on this Mac over CDP
 * using node's global WebSocket (node 21+). `npm install` is not a step, because a
 * check nobody can run is the same as no check.
 *
 *   node tools/responsive-audit.js                  # table, human
 *   node tools/responsive-audit.js --json           # machine
 *   node tools/responsive-audit.js --gate           # exit 1 if a budget is broken
 *   node tools/responsive-audit.js --widths 390,768 # subset
 *   node tools/responsive-audit.js --url http://localhost:8899/built-site/app.html
 *
 * It starts its own http server over the repo root and its own headless Chrome, and
 * shuts both down. Nothing is left running.
 *
 * MEASURE, DO NOT EYEBALL. Chrome on macOS will not narrow past ~1300px, which is
 * exactly how a 390px phone went unnoticed for a month.
 */
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const REPO = path.resolve(__dirname, "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/* The device set. Each one is a real thing somebody holds, not a round number.
   Keep this list short: every width added is a width every future change must pass. */
const DEVICES = [
  { w: 390,  h: 844,  label: "iPhone 14/15",   touch: true,  klass: "phone"  },
  { w: 430,  h: 932,  label: "iPhone Max",     touch: true,  klass: "phone"  },
  // A phone on its side is 844 wide and 390 TALL, so the breakpoint set calls it a
  // tablet while the height says otherwise. It is here because it is the one screen
  // where a wide layout and a short one meet, and it is a real thing somebody does at
  // a workshop table. If a change passes 390 and 768 but not this, the fix was keyed
  // to width when it should have been keyed to height.
  { w: 844,  h: 390,  label: "phone sideways", touch: true,  klass: "tablet" },
  { w: 768,  h: 1024, label: "iPad portrait",  touch: true,  klass: "tablet" },
  { w: 1024, h: 768,  label: "iPad landscape", touch: true,  klass: "tablet" },
  { w: 1440, h: 900,  label: "laptop",         touch: false, klass: "laptop" },
];

/* THE BUDGETS. These are the "done when" lines out of STORY-88..93, in one place.
   A change that breaks one of these fails --gate. Moving a number here is a decision
   and should be argued in the commit message. */
const BUDGET = {
  // STORY-89 + STORY-88 agreement 3: the panel exists to show stories.
  chromePct:    { phone: 50, tablet: 50, laptop: 50 },
  // STORY-89 done-when: a card is visible before anybody drags or scrolls.
  peekCards:    { phone: 1, tablet: 1, laptop: 1 },
  // STORY-93 + STORY-88 agreement 2: 44px on anything a finger is meant to hit.
  // Laptop is null because 44px is a TOUCH rule; a mouse is not a thumb.
  smallTargets: { phone: 0, tablet: 0, laptop: null },
  // STORY-92 done-when: the map is the majority of the screen when the app opens.
  mapVisible:   { phone: 55, tablet: 55, laptop: 55 },
  // STORY-92: and the layer panel is not sitting on top of it. One number at every
  // width: a control may annotate the map, it may not be a quarter of it. On a phone
  // it also defaults shut, which takes it to about 5%.
  layersPct:    { phone: 25, tablet: 25, laptop: 25 },
  // STORY-90: it may scroll, but it must say that it scrolls.
  navOverflowOk: true,
  noHScroll:     true,
  // STORY-91: an iPad in portrait is a tablet, not a big phone. No percentage
  // catches this one; the drawer at 768 was wrong even when its numbers were fine.
  layout:       { phone: "drawer", tablet: "columns", laptop: "columns" },
  // Nothing important may be sitting underneath something else. Added after the
  // Map Layers header spent a deploy hidden behind the map search box while every
  // other number in this table said it was fine.
  nothingCovered: true,
};

/* ---------------------------------------------------------------- the browser side
   Runs inside the page. Everything it returns is measured from the live layout;
   nothing is read out of the stylesheet, because the question is what happened,
   not what was asked for. */
const PROBE = function () {
  const $ = (s) => document.querySelector(s);
  const box = (el) => (el ? el.getBoundingClientRect() : null);
  const vis = (el) => {
    if (!el) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const panel = $("#panel");
  const head = $(".p-head");
  const filters = $("#filters");
  const cards = $("#cards");
  const nav = $("#mainnav");
  const maptools = $(".maptools");
  const explore = $(".explore");

  // Chrome share of the panel: everything above the story list, over the panel's own
  // height. On a phone the panel is a drawer, so measure the drawer as it sits open.
  const pB = box(panel);
  const headH = vis(head) ? box(head).height : 0;
  const filtH = vis(filters) ? box(filters).height : 0;
  const panelH = pB ? pB.height : 0;
  const chromePct = panelH ? Math.round(((headH + filtH) / panelH) * 100) : null;

  // How many story cards are actually visible inside the panel as it opens. Not
  // "rendered" — visible. A card scrolled out of view has not been shown to anybody.
  const cB = box(cards);
  let cardsVisible = 0;
  if (cB) {
    for (const c of document.querySelectorAll("#cards .card")) {
      const r = box(c);
      const top = Math.max(r.top, cB.top);
      const bottom = Math.min(r.bottom, cB.bottom);
      // count it if a majority of the card is inside the visible strip
      if (bottom - top > r.height * 0.5) cardsVisible++;
    }
  }

  // Nav overflow, and whether anything on screen says it continues.
  const navOverflow = nav ? nav.scrollWidth - nav.clientWidth : 0;
  const navAdvertised = nav
    ? (() => {
        const s = getComputedStyle(nav);
        const after = getComputedStyle(nav, "::after");
        // a fade/arrow drawn as a pseudo-element, a mask, or a visible scrollbar
        const hasFade =
          (after.content && after.content !== "none" && after.width !== "auto" && parseFloat(after.width) > 0) ||
          (s.maskImage && s.maskImage !== "none") ||
          (s.webkitMaskImage && s.webkitMaskImage !== "none");
        return !!hasFade;
      })()
    : false;

  // "Map Layers covers half a phone screen" is a question about AREA, not width.
  // A collapsed header bar 210px wide and 44px tall is 54% of the width and 4% of the
  // map. Measuring width alone would fail a panel that is out of the way, and would
  // pass a narrow one that runs the full height. Measure what it covers.
  const mtB = box(maptools);
  const mapB = box($(".mapwrap")) || { width: window.innerWidth, height: window.innerHeight };
  const layersPct = vis(maptools)
    ? Math.round(((mtB.width * mtB.height) / (mapB.width * mapB.height)) * 100)
    : 0;
  const layersW = vis(maptools) ? Math.round((mtB.width / window.innerWidth) * 100) : 0;

  // How much of the screen is actually map. In the drawer layout the panel sits ON
  // the map, so the map loses whatever the drawer covers; in the column layout the
  // map simply gets its column. One number either way, which is what STORY-92's
  // "the map is the majority of what is on screen" needs.
  const mainB = box(document.querySelector("main"));
  let mapVisiblePct = null;
  if (mainB && mapB && mainB.height) {
    const overlap =
      panel && getComputedStyle(panel).position === "absolute"
        ? Math.max(0, Math.min(mapB.bottom, pB.bottom) - Math.max(mapB.top, pB.top))
        : 0;
    const mapArea = mapB.width * Math.max(0, mapB.height - overlap);
    mapVisiblePct = Math.round((mapArea / (mainB.width * mainB.height)) * 100);
  }
  const layersCollapsed = !!(
    $("#layerPanel") && $("#layerPanel").classList.contains("collapsed")
  );

  // VISIBLE IS NOT THE SAME AS REACHABLE, and this check exists because every size
  // measurement above passed while the Map Layers header sat underneath the full-width
  // map search box. 176px wide, 44px tall, correctly collapsed, and completely
  // unavailable: a screenshot found it, no number did. Ask the document what is
  // actually at the point, rather than whether something has a size.
  // Sampled ACROSS the control, not at its centre. One point in the middle said the
  // layer header was fine at 768 while its left third and its whole label sat under
  // the search box: a control that is one third unreachable and unreadable is broken,
  // and a check that only asks about the middle would have shipped it.
  const covered = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const y = r.top + Math.min(12, r.height / 2);
    return [0.12, 0.5, 0.88].some((f) => {
      const hit = document.elementFromPoint(r.left + r.width * f, y);
      return !(hit && (el === hit || el.contains(hit) || hit.contains(el)));
    });
  };
  const layersCovered = covered($("#lpHead"));
  const searchCovered = covered($("#searchIn"));
  const addCovered = covered($("#navAdd"));
  const layersRowsShown = Array.from(document.querySelectorAll(".lrow")).filter(vis).length;

  // Everything a finger is meant to hit. The selector list is the one from STORY-93
  // plus the drawer handle and the map's own controls, because Leaflet's buttons are
  // still ours to style.
  const SEL = "button,a,select,input,.lrow,.kchip,.cchip,.fpill,.leaflet-control-zoom a";
  // Leaflet's attribution ("Leaflet · Mapbox · OpenStreetMap", 14px) is excluded on
  // purpose. It is a credit we are required to display, not a control anybody is
  // trying to hit, and inflating it to 44px would put three fat links across the
  // bottom of the map to fix a problem nobody has.
  const small = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (!vis(el) || el.closest(".leaflet-control-attribution")) continue;
    const r = el.getBoundingClientRect();
    // The visible box may be small on purpose if the HIT AREA is expanded with a
    // pseudo-element. Honour that: measure the hit area, not the paint.
    const after = getComputedStyle(el, "::after");
    let hitH = r.height;
    if (after.content && after.content !== "none" && after.position === "absolute") {
      const top = parseFloat(after.top);
      const bottom = parseFloat(after.bottom);
      if (!isNaN(top) && top < 0) hitH += -top;
      if (!isNaN(bottom) && bottom < 0) hitH += -bottom;
    }
    if (hitH < 44) {
      const id = el.id ? "#" + el.id : "";
      const cls = el.className && typeof el.className === "string"
        ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
        : "";
      small.push({
        sel: el.tagName.toLowerCase() + id + cls,
        h: Math.round(hitH * 10) / 10,
        text: (el.textContent || "").trim().slice(0, 24),
      });
    }
  }
  const byKind = {};
  for (const s of small) {
    const k = s.sel.replace(/^(\w+)(#[\w-]+)?/, "$1");
    byKind[k] = (byKind[k] || 0) + 1;
  }

  return {
    layout: explore ? getComputedStyle(explore).gridTemplateColumns : null,
    drawer: panel ? getComputedStyle(panel).position === "absolute" : null,
    panel: { w: Math.round(pB ? pB.width : 0), h: Math.round(panelH) },
    headH: Math.round(headH),
    filtH: Math.round(filtH),
    filtersOpen: !!(filters && !filters.hidden),
    chromePct,
    storyPx: Math.round(panelH - headH - filtH),
    cardsVisible,
    cardsTotal: document.querySelectorAll("#cards .card").length,
    navNeeds: nav ? nav.scrollWidth : 0,
    navGets: nav ? nav.clientWidth : 0,
    navOverflow,
    navAdvertised,
    navItemsOffscreen: nav
      ? Array.from(nav.children).filter((c) => c.getBoundingClientRect().right > nav.getBoundingClientRect().right + 1).length
      : 0,
    mapVisiblePct,
    layersPct,
    layersW,
    layersCollapsed,
    layersCovered,
    searchCovered,
    addCovered,
    layersRowsShown,
    smallCount: small.length,
    smallByKind: byKind,
    smallSample: small.slice(0, 60),
    hScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
    bodyScrollW: document.documentElement.scrollWidth,
  };
};

/* ------------------------------------------------------------------- plumbing */
function serve(root) {
  const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
    ".json": "application/json", ".geojson": "application/json", ".png": "image/png",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".webm": "audio/webm", ".m4a": "audio/mp4" };
  const srv = http.createServer((req, res) => {
    const p = path.join(root, decodeURIComponent(req.url.split("?")[0]));
    if (!p.startsWith(root)) { res.writeHead(403).end(); return; }
    fs.readFile(p, (err, buf) => {
      if (err) { res.writeHead(404).end("no"); return; }
      res.writeHead(200, { "content-type": TYPES[path.extname(p).toLowerCase()] || "application/octet-stream" });
      res.end(buf);
    });
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok(srv)));
}

async function cdp(port) {
  let info, tries = 0;
  while (tries++ < 60) {
    try {
      info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch (e) { await new Promise((r) => setTimeout(r, 150)); }
  }
  if (!info) throw new Error("Chrome never opened its debugging port");
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let id = 0;
  const waiting = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const { ok, no } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? no(new Error(msg.error.message)) : ok(msg.result);
    } else events.push(msg);
  };
  const send = (method, params, sessionId) =>
    new Promise((ok, no) => {
      const n = ++id;
      waiting.set(n, { ok, no });
      ws.send(JSON.stringify({ id: n, method, params: params || {}, sessionId }));
    });
  return { send, ws, events };
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const json = argv.includes("--json");
  const gate = argv.includes("--gate");
  /* The filter block defaults SHUT where the panel cannot afford it, so the default
     run measures a panel with no filters in it. --filters-open opens them first and
     measures the worst case a person can actually reach: they asked to see the
     filters, and now the filters are most of the panel. It is not gated, because at
     that moment the panel IS the filters and that is what was asked for. It is here
     so the number is checkable instead of argued. */
  const filtersOpen = argv.includes("--filters-open");
  const only = arg("--widths", null);
  const devices = only
    ? DEVICES.filter((d) => only.split(",").map(Number).includes(d.w))
    : DEVICES;

  const srv = await serve(REPO);
  const port = srv.address().port;
  const url = arg("--url", `http://127.0.0.1:${port}/built-site/app.html`);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "respaudit-"));
  const dport = 9333 + Math.floor((Date.now() % 500));
  const chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${dport}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--hide-scrollbars", "--force-device-scale-factor=1", "about:blank",
  ], { stdio: "ignore" });

  const out = [];
  let client;
  try {
    client = await cdp(dport);
    const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
    const S = (m, p) => client.send(m, p, sessionId);
    await S("Page.enable");
    await S("Runtime.enable");

    for (const d of devices) {
      await S("Emulation.setDeviceMetricsOverride", {
        width: d.w, height: d.h, deviceScaleFactor: 1, mobile: d.touch,
      });
      // maxTouchPoints must be 1..16 even when disabling; 0 is rejected outright.
      await S("Emulation.setTouchEmulationEnabled", { enabled: d.touch, maxTouchPoints: 5 });
      // Fresh load per width. Resizing an already-booted page hides bugs that only
      // happen when the app BOOTS at that width, which is the real case on a phone.
      await S("Page.navigate", { url });
      await new Promise((r) => setTimeout(r, 2600));

      const probe = async () => {
        const res = await S("Runtime.evaluate", {
          expression: `(${PROBE.toString()})()`, returnByValue: true, awaitPromise: false,
        });
        if (res.exceptionDetails)
          throw new Error("probe failed: " + JSON.stringify(res.exceptionDetails).slice(0, 400));
        return res.result.value;
      };

      // TWO STATES, because STORY-89 asks two different questions.
      //
      //   as it opens  — "at least one story card visible without scrolling or
      //                  dragging". On a phone that is the drawer at its PEEK height,
      //                  which is what a person sees before they touch anything.
      //   dragged open — "chrome under 50% of the open drawer". Measured shut, chrome
      //                  is 100% of nothing and the number is meaningless.
      //
      // On tablet and laptop the panel is a column and the two states are identical.
      const asOpened = await probe();
      await S("Runtime.evaluate", {
        expression: `(function(){var p=document.getElementById('panel');
          if(p&&getComputedStyle(p).position==='absolute')p.classList.add('up');
          ${filtersOpen ? `var t=document.getElementById('fToggle');
            if(t&&t.getAttribute('aria-expanded')!=='true')t.click();` : ""}})()`,
      });
      await new Promise((r) => setTimeout(r, 450));
      const dragged = await probe();

      out.push({
        ...d, ...dragged,
        // what the visitor sees before touching anything
        peekCardsVisible: asOpened.cardsVisible,
        peekPanelH: asOpened.panel.h,
        peekMapPct: asOpened.mapVisiblePct,
        layersPct: asOpened.layersPct,
        layersW: asOpened.layersW,
        layersCollapsed: asOpened.layersCollapsed,
      });
    }
  } finally {
    try { client && client.ws.close(); } catch (e) {}
    chrome.kill();
    srv.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }

  if (json) { console.log(JSON.stringify(out, null, 2)); }
  else {
    const pad = (s, n) => String(s).padEnd(n);
    const num = (s, n) => String(s).padStart(n);
    console.log("");
    console.log("  RESPONSIVE AUDIT  " + url.replace(/^http:\/\/127\.0\.0\.1:\d+/, ""));
    console.log("  " + "-".repeat(94));
    console.log("  " + pad("device", 17) + num("w", 5) + "  " + pad("layout", 9) +
      num("chrome", 7) + num("story", 7) + num("cards", 6) + num("map", 6) +
      num("layers", 7) + num("nav", 11) + num("<44px", 7) + "  hscroll");
    console.log("  " + "-".repeat(94));
    for (const r of out) {
      const navTxt = r.navOverflow > 0
        ? (r.navAdvertised ? "+" + r.navOverflow + " fade" : "+" + r.navOverflow + " HIDDEN")
        : "fits";
      console.log("  " + pad(r.label, 17) + num(r.w, 5) + "  " +
        pad(r.drawer ? "drawer" : "columns", 9) +
        num(r.chromePct + "%", 7) + num(r.storyPx + "px", 7) + num(r.peekCardsVisible, 6) +
        num(r.peekMapPct + "%", 6) + num(r.layersPct + "%", 7) +
        num(navTxt, 11) + num(r.smallCount, 7) +
        "  " + (r.hScroll ? "YES" : "no"));
    }
    console.log("  " + "-".repeat(94));
    console.log("  chrome = head+filters as a share of the panel, dragged open");
    console.log("  cards  = story cards visible AS IT OPENS, before any drag or scroll");
    console.log("  map    = share of the screen that is map as it opens");
    console.log("  layers = share of the map the Map Layers panel covers as it opens");
    console.log("");
    for (const r of out) {
      if (r.smallCount) {
        const kinds = Object.entries(r.smallByKind).map(([k, v]) => `${v} ${k}`).join(", ");
        console.log(`  ${r.w}px small targets: ${kinds}`);
      }
    }
    if (out.some((r) => r.smallCount)) console.log("");
  }

  if (gate) {
    const fails = [];
    for (const r of out) {
      const k = r.klass;
      if (BUDGET.chromePct[k] != null && r.chromePct > BUDGET.chromePct[k])
        fails.push(`${r.w}px chrome ${r.chromePct}% > ${BUDGET.chromePct[k]}% (STORY-89)`);
      if (BUDGET.smallTargets[k] != null && r.smallCount > BUDGET.smallTargets[k])
        fails.push(`${r.w}px ${r.smallCount} targets under 44px (STORY-93)`);
      if (BUDGET.layersPct[k] != null && r.layersPct > BUDGET.layersPct[k])
        fails.push(`${r.w}px Map Layers covers ${r.layersPct}% of the map > ${BUDGET.layersPct[k]}% (STORY-92)`);
      if (BUDGET.mapVisible[k] != null && r.peekMapPct < BUDGET.mapVisible[k])
        fails.push(`${r.w}px map is only ${r.peekMapPct}% of the screen on open (STORY-92)`);
      if (BUDGET.navOverflowOk && r.navOverflow > 0 && !r.navAdvertised)
        fails.push(`${r.w}px nav overflows ${r.navOverflow}px with nothing saying so (STORY-90)`);
      if (BUDGET.peekCards[k] != null && r.cardsTotal > 0 && r.peekCardsVisible < BUDGET.peekCards[k])
        fails.push(`${r.w}px no story card visible before dragging (STORY-89)`);
      if (BUDGET.noHScroll && r.hScroll)
        fails.push(`${r.w}px page scrolls sideways`);
      const want = BUDGET.layout[k], got = r.drawer ? "drawer" : "columns";
      if (want && got !== want)
        fails.push(`${r.w}px is a ${k} and got the ${got} layout (STORY-91)`);
      if (BUDGET.nothingCovered) {
        if (r.layersCovered) fails.push(`${r.w}px the Map Layers control is underneath something else (STORY-92)`);
        if (r.searchCovered) fails.push(`${r.w}px the story search box is underneath something else`);
        if (r.addCovered) fails.push(`${r.w}px the Share button is underneath something else`);
      }
    }
    if (fails.length) {
      console.error("\n  FAIL\n" + fails.map((f) => "   · " + f).join("\n") + "\n");
      process.exit(1);
    }
    console.error("\n  PASS  every budget met at " + out.map((r) => r.w).join(", ") + "\n");
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
