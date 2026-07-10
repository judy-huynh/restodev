# Culture as an Anchor — Memphis Roots

A cultural memory map for **[The Big We](https://thebigwe.org)**, gathering the
memory of Memphis corner by corner — churches, record shops, family blocks, music
venues — and asking what should grow there next. Part of the Restorative
Development work in Memphis, Tennessee.

**Live site:** https://judy-huynh.github.io/restodev/

## What's in here

| Folder | What it is |
|--------|-----------|
| `built-site/` | The map itself — the static site published to the live link above |
| `source/` | The editable configuration (`tenant.json`), the starter stories (`seeds.json`), seed media, and map overlays |
| `screenshots/` | Reference images (laptop + phone) |

## How it works

Residents share a memory tied to a specific Memphis place, choose what it's about
(a memory, family & lineage, music/art/worship, or *what should grow here*), pick
an era, and drop a pin. The result is a living community heritage map. Contributors
choose how their name appears, including a private "heritage record only" option,
and the collection belongs to the community.

The map loads its stories from a hosted database, so the site needs an internet
connection. It renders on a Mapbox base map.

## Running it locally

The site uses JavaScript modules, so serve it over `http://` rather than opening
the file directly:

```bash
cd built-site
python3 -m http.server 8000
# open http://localhost:8000/
```
