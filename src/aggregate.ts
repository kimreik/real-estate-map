import type { FilterState, Metric, Tx } from "./types";

export function matches(t: Tx, f: FilterState): boolean {
  if (t.price > f.maxPrice) return false;
  if (!f.kinds.has(t.kind)) return false;
  if (t.market !== null && !f.markets.has(t.market)) return false;
  if (t.date < f.fromDate || t.date > f.toDate) return false;
  // Area: houses frequently lack an area; only enforce when present.
  if (t.area !== null && (t.area < f.minArea || t.area > f.maxArea)) return false;
  // Rooms (izby): only flats carry it; a min-rooms filter excludes houses by design.
  if (f.minIzby > 0 && (t.izby === null || t.izby < f.minIzby)) return false;
  return true;
}

export function filterTxs(txs: Tx[], f: FilterState): Tx[] {
  return txs.filter((t) => matches(t, f));
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface DistrictStat {
  count: number; // total matching sales
  avgPpm2: number | null; // mean zł/m² over matches that have it
  medianPpm2: number | null; // median zł/m² (used for the choropleth metric)
}

/** Per-area stats computed over already-filtered rows, grouped by the given key. */
export function areaStats(filtered: Tx[], key: (t: Tx) => string | null): Map<string, DistrictStat> {
  const buckets = new Map<string, Tx[]>();
  for (const t of filtered) {
    const k = key(t);
    if (!k) continue;
    let arr = buckets.get(k);
    if (!arr) buckets.set(k, (arr = []));
    arr.push(t);
  }
  const out = new Map<string, DistrictStat>();
  for (const [district, rows] of buckets) {
    const ppm2 = rows.map((r) => r.ppm2).filter((v): v is number => v !== null);
    out.set(district, {
      count: rows.length,
      avgPpm2: ppm2.length ? Math.round(ppm2.reduce((a, b) => a + b, 0) / ppm2.length) : null,
      medianPpm2: ppm2.length ? Math.round(median(ppm2)) : null,
    });
  }
  return out;
}

/** The value that drives the choropleth colour for the chosen metric. */
export function metricValue(s: DistrictStat, metric: Metric): number | undefined {
  return metric === "count" ? s.count : s.medianPpm2 ?? undefined;
}
