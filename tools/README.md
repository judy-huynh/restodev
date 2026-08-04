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

## What is still missing

There is no saved check for the story renderers, the moderator save path, or computed
styles. Those were verified on 2026-08-04 by scripts written into a browser console
and never saved: 26,100 computed style properties across 1,044 elements, byte-identical
HTML from all four story renderers, and 4,320 payload cases on the moderator save path.
The method is worth recreating as files here. Verify by comparing outputs, not by
reading diffs.
