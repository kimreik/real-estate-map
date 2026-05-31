# Warsaw sold-prices map

> 🤖 **Built end-to-end by [Claude Code](https://claude.com/claude-code) in ~2 hours** — as a
> demonstration of what AI-assisted development can do. From a one-paragraph idea, Claude
> researched the data source, reverse-engineered a 2.9 GB relational GML export, wrote the
> Python data pipeline, built the MapLibre frontend, and debugged it live in a headless
> browser — all in a single session. Every design decision was made by the human; every line
> of code was written by the AI.

A static, backend-free map of **real residential transaction prices** in Warsaw, drawn
from Poland's *Rejestr Cen Nieruchomości* (RCN). Filter by price, area, rooms, market and
date; the 18 districts recolour live by matching-sale count (or median zł/m²). Zoom into a
district to see a heatmap of concentration, then individual clickable sales.

Everything runs in the browser — deployable to GitHub Pages.

## How it works

```
data/RCN_*.gml  ──prepare_data.py──▶  public/data/transactions.json   (slim, ~2.6 MB)
(raw, ~3 GB)                          public/data/districts.geojson
                                              │
                                       Vite + MapLibre GL (src/)  ──▶  static site
```

The frontend filters and aggregates all ~34k sales client-side, so there is no API.

## Regenerating the data

The raw RCN GML is **not** committed (it's ~3 GB and its redistribution terms are unclear —
see below). To rebuild the JSON from a fresh download:

1. Download Warsaw's RCN GML (TERYT 1465) — e.g. from the
   [Warsaw city portal](https://architektura.um.warszawa.pl/udostepniane-dane-rcn1) or the
   [national geoportal](https://www.geoportal.gov.pl/mapy/rejestr-cen-nieruchomosci/)
   (*Dane do pobrania → Dane powiatowe → Transakcje*). Save it under `data/`.
2. Point `RAW_GML` in `data/prepare_data.py` at the file if the name differs.
3. Run the script:

   ```bash
   python3 -m venv .venv && source .venv/bin/activate
   pip install -r data/requirements.txt
   python3 data/prepare_data.py        # ~40s; writes public/data/*.json
   ```

What the script keeps (see the `Config` block to adjust): residential **flats**
(`funkcjaLokalu = mieszkalna`) and **houses** (developed plots with a residential building),
**free-market or untyped** deeds only, dated **2025-01-01 onward**. Two price-quality gates
apply: an absolute sanity floor/ceiling, and a **relative gate** that drops flats priced below
`ANOMALY_FRACTION` (50%) of their own district's median zł/m² — these are almost always
under-declared or related-party prices the absolute floor can't catch. Geometry is reprojected
EPSG:2178 → WGS84 and each sale is tagged with its district.

## Develop & build

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # -> dist/  (type-checks, then bundles)
```

## Deploy (GitHub Pages)

`.github/workflows/deploy.yml` builds and publishes `dist/` on every push to `main`.
Enable **Settings → Pages → Source: GitHub Actions** once. The Vite `base` is relative, so
it works under any `user.github.io/<repo>/` subpath.

## Caveats worth knowing

- **Rooms = `izby`, not "pokoje".** RCN records *izby* (a separate kitchen counts as a room;
  bathrooms and hallways do not). It is not the colloquial bedroom+living-room count, and the
  data can't distinguish a separate kitchen from an open kitchenette. Houses have no room count.
- **Recent months undercount.** Notarial deeds reach the register with a lag, so the latest
  weeks are incomplete.
- **Points are parcel/address-level** — multiple flats in one building share a coordinate.
- **Licensing for public deployment.** RCN became free to access on 13 Feb 2026, but the
  standard geoportal bulk download may carry a *"no internet publication"* clause, whereas the
  per-powiat datasets on [dane.gov.pl](https://dane.gov.pl) are CC BY 4.0. **Verify the terms
  for your specific source before publishing**, and attribute GUGiK/PZGiK.
