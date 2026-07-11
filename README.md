# Memphis Roots — The Big We

A community **cultural-memory map** for [The Big We](https://thebigwe.org), part of the
Restorative Development work anchored on **Clayborn Temple** in Memphis, Tennessee.
*Culture as the root of healing — memories, visions, and open spaces, told corner by corner
by the people who lived it.*

**Live:** https://judy-huynh.github.io/restodev/

## What's here
The published site lives in [`built-site/`](built-site) (deployed to GitHub Pages by
`.github/workflows/pages.yml`):

| File | What it is |
|---|---|
| `built-site/index.html` | **The Clayborn Time Machine** — a scrollytelling landing page that opens into the live map |
| `built-site/app.html` | **The living map** — story panel, filters, capture, moderation, an Impact dashboard, an Open-Spaces commons, and shared-dreams futures |
| `built-site/media/` | Seed photos + one audio clip |

## Run locally
```bash
cd built-site
python3 -m http.server 8000
# open http://localhost:8000/index.html   (landing)
#   or http://localhost:8000/app.html      (map)
```

`app.html` URL parameters: `?mode=share` (capture) · `?mode=kiosk` (event) · `?mode=admin`
(moderation) · `?campaign=juneteenth&event=Alley%20Days` · `?kind=memory|future`.

## About the data
This build is **self-contained** — everything lives in the browser's `localStorage`, with no
backend and no login. Submissions are per-device only; it is **not** yet a shared database. A
shared version (Supabase → later Cloudflare) is planned.

> **The seed stories are illustrative.** Names are fictional, photos are openly licensed, and
> the sample audio is generated. They set the tone; they are not real community testimony yet.

## Inspiration & credits
- **The Big We** — Anasa Troutman; the Restorative Development model.
- **Jayne Engle** — *Sacred Civics: Building Seven Generation Cities*, **7GenCities**, and
  **Permissioning the City** (Dark Matter Labs) — inspiring the Open-Spaces commons, the
  "shared dreams, made visible" feature, and *Imagining 2068*.
- **Rebuild by Design** — Judy Huynh.

---
*The previous "Culture as an Anchor" (V2) build is preserved on the [`v2-archive`](../../tree/v2-archive) branch.*
