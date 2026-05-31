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
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Per-district value for the chosen metric, computed over already-filtered rows. */
export function aggregateByDistrict(filtered: Tx[], metric: Metric): Map<string, number> {
  const buckets = new Map<string, Tx[]>();
  for (const t of filtered) {
    if (!t.district) continue;
    (buckets.get(t.district) ?? buckets.set(t.district, []).get(t.district)!).push(t);
  }
  const out = new Map<string, number>();
  for (const [district, rows] of buckets) {
    if (metric === "count") {
      out.set(district, rows.length);
    } else {
      const ppm2 = rows.map((r) => r.ppm2).filter((v): v is number => v !== null);
      if (ppm2.length) out.set(district, Math.round(median(ppm2)));
    }
  }
  return out;
}
