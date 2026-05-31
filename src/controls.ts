import type { Dataset, FilterState, Metric } from "./types";

const pln = new Intl.NumberFormat("pl-PL");
const fmtPrice = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : pln.format(n));

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, attrs);
  for (const c of children) node.append(c);
  return node;
}

export interface Controls {
  state: FilterState;
  metric: Metric;
  setResultCount(n: number): void;
  setLegend(items: { color: string; from: number; to: number | null }[], metric: Metric): void;
}

export function buildControls(
  panel: HTMLElement,
  ds: Dataset,
  onChange: () => void,
): Controls {
  const r = ds.ranges;
  const state: FilterState = {
    maxPrice: r.priceMax,
    minArea: 0,
    maxArea: r.areaMax,
    minIzby: 0,
    kinds: new Set(["flat", "house"]),
    markets: new Set([1, 2]),
    fromDate: r.dateMin,
    toDate: r.dateMax,
  };
  let metric: Metric = "count";

  // --- header ---
  panel.append(
    el("h1", { textContent: "Warsaw sold prices" }),
    el("p", {
      className: "sub",
      textContent: "Real notarial transaction prices (RCN), residential only, from 2025.",
    }),
  );

  // --- metric toggle ---
  const metricWrap = el("div", { className: "seg" });
  const mCount = el("button", { className: "active", textContent: "Count" });
  const mPpm2 = el("button", { textContent: "Median zł/m²" });
  mCount.onclick = () => {
    metric = "count";
    mCount.classList.add("active");
    mPpm2.classList.remove("active");
    onChange();
  };
  mPpm2.onclick = () => {
    metric = "median_ppm2";
    mPpm2.classList.add("active");
    mCount.classList.remove("active");
    onChange();
  };
  metricWrap.append(mCount, mPpm2);
  panel.append(field("Colour districts by", metricWrap));

  // --- max price (headline) ---
  const priceVal = el("span", { className: "val" });
  const price = el("input", {
    type: "range",
    min: "100000",
    max: String(r.priceMax),
    step: "25000",
    value: String(state.maxPrice),
  });
  const syncPrice = () => (priceVal.textContent = `≤ ${fmtPrice(state.maxPrice)} zł`);
  price.oninput = () => {
    state.maxPrice = Number(price.value);
    syncPrice();
    onChange();
  };
  syncPrice();
  panel.append(field("Max price", wrap(price, priceVal)));

  // --- min rooms (izby) ---
  const izbyVal = el("span", { className: "val" });
  const izby = el("input", { type: "range", min: "0", max: String(r.izbyMax), step: "1", value: "0" });
  const syncIzby = () => (izbyVal.textContent = state.minIzby === 0 ? "any" : `${state.minIzby}+`);
  izby.oninput = () => {
    state.minIzby = Number(izby.value);
    syncIzby();
    onChange();
  };
  syncIzby();
  panel.append(
    field("Min rooms (izby)", wrap(izby, izbyVal), "‘izby’ counts a separate kitchen, not bathrooms/halls. Houses have no room count, so a min here hides them."),
  );

  // --- area min/max ---
  const areaVal = el("span", { className: "val" });
  const areaMin = el("input", { type: "range", min: "0", max: String(r.areaMax), step: "5", value: "0" });
  const areaMax = el("input", { type: "range", min: "0", max: String(r.areaMax), step: "5", value: String(r.areaMax) });
  const syncArea = () => (areaVal.textContent = `${state.minArea}–${state.maxArea} m²`);
  areaMin.oninput = () => {
    state.minArea = Math.min(Number(areaMin.value), state.maxArea);
    areaMin.value = String(state.minArea);
    syncArea();
    onChange();
  };
  areaMax.oninput = () => {
    state.maxArea = Math.max(Number(areaMax.value), state.minArea);
    areaMax.value = String(state.maxArea);
    syncArea();
    onChange();
  };
  syncArea();
  panel.append(field("Area", wrap(el("div", { className: "dual" }, [areaMin, areaMax]), areaVal)));

  // --- kind & market checkboxes ---
  panel.append(
    field(
      "Property type",
      checks(
        [
          ["flat", "Flats", true],
          ["house", "Houses", true],
        ],
        (key, on) => {
          on ? state.kinds.add(key as "flat" | "house") : state.kinds.delete(key as "flat" | "house");
          onChange();
        },
      ),
    ),
    field(
      "Market",
      checks(
        [
          ["1", "Primary", true],
          ["2", "Secondary", true],
        ],
        (key, on) => {
          const m = Number(key) as 1 | 2;
          on ? state.markets.add(m) : state.markets.delete(m);
          onChange();
        },
      ),
    ),
  );

  // --- date range ---
  const from = el("input", { type: "date", value: r.dateMin, min: r.dateMin, max: r.dateMax });
  const to = el("input", { type: "date", value: r.dateMax, min: r.dateMin, max: r.dateMax });
  from.onchange = () => {
    state.fromDate = from.value;
    onChange();
  };
  to.onchange = () => {
    state.toDate = to.value;
    onChange();
  };
  panel.append(field("Sold between", el("div", { className: "dual" }, [from, to])));

  // --- result count + legend + footnote ---
  const count = el("div", { className: "count" });
  const legend = el("div", { className: "legend" });
  panel.append(count, legend);
  panel.append(
    el("p", {
      className: "foot",
      innerHTML:
        "Recent months undercount — notarial deeds reach the register with a lag. " +
        'Data: <a href="https://www.geoportal.gov.pl/mapy/rejestr-cen-nieruchomosci/" target="_blank" rel="noopener">RCN / GUGiK</a>. ' +
        "Zoom in to a district to see individual sales.",
    }),
  );

  return {
    state,
    get metric() {
      return metric;
    },
    setResultCount(n: number) {
      count.textContent = `${pln.format(n)} matching sales`;
    },
    setLegend(items, m) {
      legend.innerHTML = "";
      const unit = (v: number) => (m === "count" ? pln.format(Math.round(v)) : `${pln.format(Math.round(v))} zł/m²`);
      legend.append(el("div", { className: "legend-title", textContent: m === "count" ? "Sales per district" : "Median zł/m²" }));
      for (const it of items) {
        const label = it.to === null ? `${unit(it.from)}+` : `${unit(it.from)}–${unit(it.to)}`;
        const swatch = el("span", { className: "swatch" });
        swatch.style.background = it.color;
        legend.append(el("div", { className: "legend-row" }, [swatch, el("span", { textContent: label })]));
      }
    },
  } as Controls;
}

// --- tiny DOM helpers ---
function field(label: string, control: Node, hint?: string): HTMLElement {
  const f = el("div", { className: "field" }, [el("label", { textContent: label }), control]);
  if (hint) f.append(el("p", { className: "hint", textContent: hint }));
  return f;
}
function wrap(...nodes: Node[]): HTMLElement {
  return el("div", { className: "row" }, nodes);
}
function checks(
  items: [string, string, boolean][],
  onToggle: (key: string, on: boolean) => void,
): HTMLElement {
  const box = el("div", { className: "checks" });
  for (const [key, label, def] of items) {
    const input = el("input", { type: "checkbox", checked: def });
    input.onchange = () => onToggle(key, input.checked);
    box.append(el("label", { className: "chk" }, [input, document.createTextNode(label)]));
  }
  return box;
}
