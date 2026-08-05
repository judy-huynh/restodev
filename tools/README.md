# tools

Checks for `built-site/app.html`. **Not part of the site.** Nothing here is served,
deployed, or run in a browser by a visitor. These are scripts you run from a terminal
before you commit.

`app.html` is one 4,300-line file on purpose, so the usual safety net of "the module
that broke is the module you edited" does not exist here. These two scripts are the
net instead. Both take the version you are replacing and the version you wrote, and
compare what the two of them produce.

```sh
git show HEAD:built-site/app.html > /tmp/base.html

python3 tools/qa.py            /tmp/base.html built-site/app.html
node    tools/filters-test.js  /tmp/base.html built-site/app.html
node    tools/responsive-audit.js --gate
```

Neither checks that the JavaScript parses. Do that too:

```sh
python3 -c "s=open('built-site/app.html').read(); a=s.find('<script>\n\"use strict\"'); open('/tmp/a.js','w').write(s[a+8:s.rfind('</script>')])"
node --check /tmp/a.js
```

## qa.py

The structural gate, in order of how badly each check has bitten this project:

1. CSS comments balance, and no rule is swallowed by an unterminated one. A dropped
   `*/` once silently removed `.cards{overflow:auto}` and would have shipped a story
   list that does not scroll.
2. CSS rule-set diff: every selector and its declarations, per media context.
3. Every `$("id")` in the script resolves to a real `id=` in the markup.

Known limitation: the rule parser keeps only the last of duplicate selectors, so
merging two rules for the same selector reads as a change when it is not. Check those
against the browser's CSSOM instead.

## filters-test.js

A behavioural check on the filter layer and the shareable URL. It loads the filter
code out of **both** files, drives the two copies through the same states, and compares
what each one produces: `passes()` over every story, the count on the Filters toggle,
the `<option>` markup of all three dropdowns character for character, the active-filter
row, the query string a filter state produces, and the filter state a URL produces.
Roughly 4,400 comparisons across 576 states, 40 links and 40 round trips.

It reads the script by slicing it, not by running it, because running `app.html` whole
needs Leaflet, Mapbox and a DOM. Function bodies are cut out by brace matching, so
nothing is retyped and the check cannot drift from the file it is checking. Rename a
function it needs and it fails loudly instead of quietly comparing nothing.

**`EXPECTED_DIFFS` is the part to understand.** A deliberate behaviour change is
declared there; anything that differs and is not declared fails the run. That makes
"nothing changed" and "these four things changed, on purpose" both provable, which is
the whole point. Clear it out when you start a new change.

## responsive-audit.js

The layout check, and the only one of the three that opens a browser. It drives the
Chrome already on this Mac over CDP, loads `app.html` at five real device widths, and
**measures what rendered** rather than reading the media queries.

```sh
node tools/responsive-audit.js            # the table
node tools/responsive-audit.js --gate     # exit 1 if a budget is broken
node tools/responsive-audit.js --json     # every field, including each small target
node tools/responsive-audit.js --widths 390,768
```

No `npm install`. It starts its own web server and its own headless Chrome and shuts
both down; nothing is left running.

**`BUDGET` at the top of the file is the part to understand.** It is the "done when"
line out of each of STORY-88 to 93, in one place: chrome under 50% of the panel, a
story card visible before anybody drags, nothing under 44px on a touch screen, the map
the majority of the screen, the nav advertising that it scrolls, and a tablet getting
the tablet layout. Changing a number there is a design decision and belongs in a commit
message, not in a passing run.

Two things it measures more carefully than they look:

- **Two panel states.** On a phone the panel is a drawer, so "is a story visible" is
  asked of the **peek** height, before anybody touches it, and "how much is chrome" is
  asked of the **dragged-open** height, where the question means something.
- **Hit area, not paint.** A control whose visible box is 24px but which expands its
  hit area with an absolutely-positioned `::after` counts as its real hit area. That is
  how the story chips pass without every card growing 80px.

Leaflet's attribution links are excluded. They are a credit we must display, not a
control anybody is aiming at.

## What is still missing

There is no saved check for the story renderers or the moderator save path. Those were
verified on 2026-08-04 by scripts written into a browser console and never saved:
byte-identical HTML from all four story renderers, and 4,320 payload cases on the
moderator save path. The method is worth recreating as files here. Verify by comparing
outputs, not by reading diffs.

The computed-style differ from that day is **superseded** by `responsive-audit.js`,
which measures the same way but asks a question with an answer in it. A diff of 26,100
properties tells you something moved; a budget tells you whether it is now wrong.
