// One residential sale. Mirrors the columnar `fields` order written by data/prepare_data.py.
export interface Tx {
  lon: number;
  lat: number;
  price: number; // total transaction price, zł
  area: number | null; // usable area m² (often null for houses)
  ppm2: number | null; // zł per m² (null when area missing)
  izby: number | null; // RCN "liczba izb" — a separate kitchen counts; null for houses
  floor: number | null;
  date: string; // YYYY-MM-DD (notarial deed date)
  market: 1 | 2 | null; // 1 = primary (rynek pierwotny), 2 = secondary
  kind: "flat" | "house";
  district: string | null;
  msi: string | null; // MSI neighborhood (e.g. "Błonia Wilanowskie")
}

export interface FilterState {
  maxPrice: number; // headline control
  minArea: number;
  maxArea: number;
  minIzby: number; // 0 = any
  kinds: Set<"flat" | "house">;
  markets: Set<1 | 2>;
  fromDate: string;
  toDate: string;
}

export type Metric = "count" | "median_ppm2";

export interface Dataset {
  txs: Tx[];
  ranges: {
    priceMax: number; // cap used for the price slider
    areaMax: number;
    izbyMax: number;
    dateMin: string;
    dateMax: string;
  };
}
