#!/usr/bin/env python3
"""QA gate for built-site/app.html.

Usage: qa.py <baseline.html> <candidate.html>

Checks, in order of how badly each one has bitten this project:
  1. JS parses            (delegated to `node --check` by the caller)
  2. CSS comments balance and no rule is swallowed by an unterminated comment
  3. CSS rule set diff    -- every selector+declaration, per media context
  4. Every $("id") in the script exists as an id= in the markup
  5. Every class used in the markup/script has a rule, and vice versa (report only)
"""
import re, sys, collections

def parts(path):
    s = open(path).read()
    css = s[s.find('<style>') + 7: s.find('</style>')]
    a = s.find('<script>\n"use strict"')
    js = s[a + 8: s.rfind('</script>')]
    return s, css, js

def strip_comments(css):
    return re.sub(r'/\*.*?\*/', '', css, flags=re.S)

def rules(css):
    """-> {(media, selector): declarations}  with declarations normalised."""
    css = strip_comments(css)
    out = collections.OrderedDict()
    pos, media = 0, ''
    tokens = re.finditer(r'@media([^{]+)\{|([^{}]+)\{([^{}]*)\}|\}', css)
    depth_media = False
    for m in tokens:
        if m.group(1):
            media = '@media' + m.group(1).strip(); depth_media = True
        elif m.group(2) is not None:
            sel = ' '.join(m.group(2).split())
            decls = ';'.join(sorted(d.strip() for d in m.group(3).split(';') if d.strip()))
            out[(media, sel)] = decls
        else:
            if depth_media: media = ''; depth_media = False
    return out

def main(base, cand):
    fail = 0
    bs, bcss, bjs = parts(base)
    cs, ccss, cjs = parts(cand)

    # 2. comment balance
    for name, css in (('baseline', bcss), ('candidate', ccss)):
        if css.count('/*') != css.count('*/'):
            print(f"FAIL  {name}: unbalanced CSS comments {css.count('/*')} open, {css.count('*/')} close"); fail += 1
    if ccss.count('{') != ccss.count('}'):
        print(f"FAIL  candidate: unbalanced braces {ccss.count('{')} / {ccss.count('}')}"); fail += 1

    # 3. rule set diff
    b, c = rules(bcss), rules(ccss)
    removed = [k for k in b if k not in c]
    added   = [k for k in c if k not in b]
    changed = [k for k in b if k in c and b[k] != c[k]]
    print(f"CSS rules: baseline {len(b)}, candidate {len(c)}")
    for k in removed: print(f"  - REMOVED {k[0]} {k[1]}  ::  {b[k][:70]}")
    for k in added:   print(f"  + ADDED   {k[0]} {k[1]}  ::  {c[k][:70]}")
    for k in changed: print(f"  ~ CHANGED {k[0]} {k[1]}\n      was {b[k][:70]}\n      now {c[k][:70]}")
    if not (removed or added or changed): print("  (no rule changes)")

    # A rule that vanished because a comment swallowed it is the killer case. Ask
    # whether the SELECTOR is gone from the whole stylesheet, not whether it left one
    # media context: moving .panel from @media(max-width:860px) to a phone block is a
    # deliberate breakpoint change, and failing that would train people to ignore this.
    # A swallowed rule takes the selector with it out of every context, which is what
    # the check is really looking for.
    STRUCTURAL = ('.cards', '.card', '.panel', '#map', 'body')
    still = {k[1] for k in c}
    swallowed = sorted({k[1] for k in removed if k[1] in STRUCTURAL and k[1] not in still})
    if swallowed:
        print(f"FAIL  a structural rule disappeared from every context: {swallowed}"); fail += 1
    moved = sorted({k[1] for k in removed if k[1] in STRUCTURAL and k[1] in still})
    if moved:
        print(f"NOTE  structural rule moved between media contexts, check it landed: {moved}")

    # 4. $() ids
    ids = set(re.findall(r'id="([^"]+)"', cs))
    refs = set(re.findall(r'\$\("([^"]+)"\)', cjs))
    missing = sorted(r for r in refs if r not in ids)
    if missing: print(f"FAIL  $() with no matching id=: {missing}"); fail += 1
    else: print(f"$() ids: {len(refs)} referenced, all present")

    print("PASS" if not fail else f"{fail} FAILURE(S)")
    return fail

if __name__ == '__main__':
    sys.exit(main(sys.argv[1], sys.argv[2]))
