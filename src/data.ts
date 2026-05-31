import type { Dataset, Tx } from "./types";

interface RawPayload {
  generated: string;
  cutoff: string;
  fields: string[];
  rows: unknown[][];
}

const base = import.meta.env.BASE_URL;

export async function loadDataset(): Promise<Dataset> {
  const res = await fetch(`${base}data/transactions.json`);
  if (!res.ok) throw new Error(`failed to load transactions.json: ${res.status}`);
  const raw = (await res.json()) as RawPayload;

  const f = Object.fromEntries(raw.fields.map((name, i) => [name, i]));
  const txs: Tx[] = raw.rows.map((r) => ({
    lon: r[f.lon] as number,
    lat: r[f.lat] as number,
    price: r[f.price] as number,
    area: r[f.area] as number | null,
    ppm2: r[f.ppm2] as number | null,
    izby: r[f.izby] as number | null,
    floor: r[f.floor] as number | null,
    date: r[f.date] as string,
    market: r[f.market] as 1 | 2 | null,
    kind: r[f.kind] as "flat" | "house",
    district: r[f.district] as string | null,
  }));

  // Slider ranges derived from the data, with a price cap so a handful of
  // multi-million outliers don't make the slider useless.
  const prices = txs.map((t) => t.price).sort((a, b) => a - b);
  const priceCap = Math.ceil(prices[Math.floor(prices.length * 0.98)] / 100000) * 100000;
  const areaMax = Math.ceil(Math.max(...txs.map((t) => t.area ?? 0)) / 10) * 10;
  const izbyMax = Math.min(7, Math.max(...txs.map((t) => t.izby ?? 0)));
  const dates = txs.map((t) => t.date).sort();

  return {
    txs,
    ranges: {
      priceMax: priceCap,
      areaMax: Math.min(areaMax, 250),
      izbyMax,
      dateMin: dates[0] ?? raw.cutoff,
      dateMax: dates[dates.length - 1] ?? raw.cutoff,
    },
  };
}

export async function loadDistricts(): Promise<GeoJSON.FeatureCollection> {
  const res = await fetch(`${base}data/districts.geojson`);
  if (!res.ok) throw new Error(`failed to load districts.geojson: ${res.status}`);
  return (await res.json()) as GeoJSON.FeatureCollection;
}
