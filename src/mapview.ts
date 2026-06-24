import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Metric, Tx } from "./types";
import { metricValue, type DistrictStat } from "./aggregate";
import { quantileScale, type Scale } from "./colors";

// Zoom bands, coarse -> fine:
//   < NB_IN            districts choropleth
//   NB_IN .. DRILL     neighbourhoods (MSI) choropleth
//   DRILL .. POINT     heatmap of concentration
//   >= POINT           individual clickable sales
const NB_IN = 11.5;
const DRILL_ZOOM = 13.0;
const POINT_ZOOM = 14.5;
const WARSAW: [number, number] = [21.01, 52.23];

const CARTO_ATTRIB =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>';

interface AreaProps {
  name: string;
  fillColor?: string;
  count?: number;
  avgPpm2?: number | null;
  medianPpm2?: number | null;
}

export class MapView {
  readonly map: maplibregl.Map;
  private districts: GeoJSON.FeatureCollection;
  private neighborhoods: GeoJSON.FeatureCollection;
  private ready = false;
  private onReady: (() => void)[] = [];
  private dScale: Scale | null = null;
  private nbScale: Scale | null = null;
  private lastMetric: Metric = "count";

  constructor(container: string, districts: GeoJSON.FeatureCollection, neighborhoods: GeoJSON.FeatureCollection) {
    this.districts = districts;
    this.neighborhoods = neighborhoods;
    this.map = new maplibregl.Map({
      container,
      center: WARSAW,
      zoom: 10.3,
      attributionControl: false,
      style: {
        version: 8,
        glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
        sources: {
          carto: {
            type: "raster",
            tiles: ["https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"],
            tileSize: 256,
            attribution: CARTO_ATTRIB,
          },
        },
        layers: [{ id: "carto", type: "raster", source: "carto" }],
      },
    });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    this.map.addControl(new maplibregl.AttributionControl({ compact: true }));
    this.map.on("load", () => this.init());
  }

  whenReady(cb: () => void) {
    if (this.ready) cb();
    else this.onReady.push(cb);
  }

  private addAreaLayers(id: string, data: GeoJSON.FeatureCollection, fillOpacity: unknown, lineOpacity: unknown) {
    this.map.addSource(id, { type: "geojson", data });
    this.map.addLayer({
      id: `${id}-fill`,
      type: "fill",
      source: id,
      paint: {
        "fill-color": ["coalesce", ["get", "fillColor"], "rgba(0,0,0,0)"],
        "fill-opacity": fillOpacity as maplibregl.DataDrivenPropertyValueSpecification<number>,
      },
    });
    this.map.addLayer({
      id: `${id}-border`,
      type: "line",
      source: id,
      paint: {
        "line-color": "#555",
        "line-width": id === "districts" ? 1 : 0.6,
        "line-opacity": lineOpacity as maplibregl.DataDrivenPropertyValueSpecification<number>,
      },
    });
  }

  private init() {
    // Districts: visible at the lowest zooms, fade out as neighbourhoods fade in.
    this.addAreaLayers(
      "districts",
      this.districts,
      ["interpolate", ["linear"], ["zoom"], 10.0, 0.72, NB_IN, 0.0],
      ["interpolate", ["linear"], ["zoom"], 10.0, 0.9, NB_IN, 0.2], // fade to faint context once neighbourhoods appear
    );
    // Neighbourhoods (MSI): borders appear exactly at NB_IN (the hover crossover) and stay
    // visible through the heatmap zoom until points take over; the fill fades at DRILL_ZOOM
    // so the heatmap can show concentration underneath.
    this.addAreaLayers(
      "neighborhoods",
      this.neighborhoods,
      ["interpolate", ["linear"], ["zoom"], NB_IN, 0, NB_IN + 0.4, 0.7, DRILL_ZOOM - 0.3, 0.7, DRILL_ZOOM, 0],
      ["interpolate", ["linear"], ["zoom"], NB_IN, 0, NB_IN + 0.3, 0.55, POINT_ZOOM - 0.3, 0.55, POINT_ZOOM, 0],
    );

    // Drill-down: heatmap of concentration, then individual points.
    this.map.addSource("points", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    this.map.addLayer({
      id: "heat",
      type: "heatmap",
      source: "points",
      minzoom: DRILL_ZOOM - 0.5,
      paint: {
        "heatmap-weight": 0.6,
        "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], DRILL_ZOOM, 1, 16, 3],
        "heatmap-radius": ["interpolate", ["linear"], ["zoom"], DRILL_ZOOM, 12, 16, 30],
        "heatmap-color": [
          "interpolate", ["linear"], ["heatmap-density"],
          0, "rgba(255,255,178,0)",
          0.2, "#fed976", 0.4, "#feb24c", 0.6, "#fd8d3c", 0.8, "#f03b20", 1, "#bd0026",
        ],
        "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], POINT_ZOOM, 0.85, POINT_ZOOM + 2, 0.15],
      },
    });
    this.map.addLayer({
      id: "point",
      type: "circle",
      source: "points",
      minzoom: POINT_ZOOM,
      paint: {
        "circle-color": ["case", ["==", ["get", "kind"], "house"], "#2e7d32", "#c62828"],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], POINT_ZOOM, 3, 17, 7],
        "circle-stroke-width": 1,
        "circle-stroke-color": "#fff",
        "circle-opacity": ["interpolate", ["linear"], ["zoom"], POINT_ZOOM, 0.2, POINT_ZOOM + 1.5, 0.9],
      },
    });

    this.wireInteractions();
    this.ready = true;
    this.onReady.forEach((cb) => cb());
  }

  private wireInteractions() {
    this.wireAreaHover();
    this.wirePointClick();
  }

  /**
   * One tooltip whose tier follows the zoom: districts below NB_IN, neighbourhoods from NB_IN
   * until individual sales become clickable (POINT_ZOOM) — i.e. while their borders are shown.
   * A single map-level handler (rather than one per layer) avoids the two stacked fill layers
   * fighting over the same tooltip.
   */
  private wireAreaHover() {
    const tip = new maplibregl.Popup({
      closeButton: false, closeOnClick: false, className: "district-tip", anchor: "bottom-left", offset: 12,
    });
    const pln = new Intl.NumberFormat("pl-PL");
    let hovered: string | null = null;
    const clear = () => {
      if (hovered !== null) { tip.remove(); hovered = null; }
    };
    this.map.on("mousemove", (e) => {
      const z = this.map.getZoom();
      const level = z < NB_IN ? "districts" : z < POINT_ZOOM ? "neighborhoods" : null;
      if (!level) { clear(); return; } // point zoom: only sales are interactive
      const f = this.map.queryRenderedFeatures(e.point, { layers: [`${level}-fill`] })[0];
      const p = f?.properties as AreaProps | undefined;
      if (!p?.name) { clear(); return; }
      tip.setLngLat(e.lngLat);
      const key = `${level}:${p.name}`;
      if (key !== hovered) {
        hovered = key;
        const ppm2 = (v: number | null | undefined) =>
          v != null && (v as unknown) !== "null" ? `${pln.format(Number(v))} zł/m²` : "—";
        tip.setHTML(
          `<strong>${p.name}</strong><br>${pln.format(Number(p.count ?? 0))} matches` +
            `<br>avg ${ppm2(p.avgPpm2)}<br>median ${ppm2(p.medianPpm2)}`,
        );
        if (!tip.isOpen()) tip.addTo(this.map);
      }
    });
    this.map.on("mouseout", clear);
  }

  /** Click a point (or hot stack) -> list every coincident sale. */
  private wirePointClick() {
    this.map.on("click", "point", (e) => {
      const feats = e.features ?? [];
      if (!feats.length) return;
      const fmt = (n: number) => new Intl.NumberFormat("pl-PL").format(n);
      const has = (v: unknown) => v !== null && v !== undefined && v !== "" && v !== "null";
      const line = (p: Record<string, unknown>) => {
        const area = has(p.area) ? `${p.area} m²` : "—";
        const ppm2 = has(p.ppm2) ? `${fmt(Number(p.ppm2))} zł/m²` : "—";
        const rooms = p.kind !== "house" && has(p.izby) ? ` · ${p.izby}-r` : "";
        return `<div class="sale">${fmt(Number(p.price))} zł · ${area} · ${ppm2}${rooms} · ${p.date}</div>`;
      };
      const props = feats
        .map((f) => f.properties as Record<string, unknown>)
        .sort((a, b) => String(b.date).localeCompare(String(a.date)));
      const n = props.length;
      new maplibregl.Popup({ maxWidth: "none" })
        .setLngLat(e.lngLat)
        .setHTML(
          `<div class="sale-head"><strong>${props[0]?.msi ?? props[0]?.district ?? ""}</strong> · ${n} sale${n === 1 ? "" : "s"} here</div>` +
            `<div class="sales">${props.map(line).join("")}</div>`,
        )
        .addTo(this.map);
    });
    this.map.on("mouseenter", "point", () => (this.map.getCanvas().style.cursor = "pointer"));
    this.map.on("mouseleave", "point", () => (this.map.getCanvas().style.cursor = ""));
  }

  private colorAreas(source: string, data: GeoJSON.FeatureCollection, stats: Map<string, DistrictStat>, metric: Metric): Scale {
    const values: number[] = [];
    for (const s of stats.values()) {
      const v = metricValue(s, metric);
      if (v !== undefined && Number.isFinite(v)) values.push(v);
    }
    const scale = quantileScale(values);
    for (const f of data.features) {
      const props = f.properties as AreaProps;
      const s = stats.get(props.name);
      const v = s ? metricValue(s, metric) : undefined;
      props.fillColor = v === undefined ? "rgba(0,0,0,0)" : scale.colorFor(v);
      props.count = s?.count ?? 0;
      props.avgPpm2 = s?.avgPpm2 ?? null;
      props.medianPpm2 = s?.medianPpm2 ?? null;
    }
    (this.map.getSource(source) as maplibregl.GeoJSONSource).setData(data);
    return scale;
  }

  /** Recolour both choropleth tiers for the chosen metric. */
  setChoropleth(districtStats: Map<string, DistrictStat>, neighborhoodStats: Map<string, DistrictStat>, metric: Metric) {
    this.lastMetric = metric;
    this.dScale = this.colorAreas("districts", this.districts, districtStats, metric);
    this.nbScale = this.colorAreas("neighborhoods", this.neighborhoods, neighborhoodStats, metric);
  }

  /** Replace the drill-down point set. */
  setPoints(txs: Tx[]) {
    const src = this.map.getSource("points") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData({
      type: "FeatureCollection",
      features: txs.map((t) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [t.lon, t.lat] },
        properties: {
          price: t.price, area: t.area, ppm2: t.ppm2, izby: t.izby,
          kind: t.kind, district: t.district, msi: t.msi, date: t.date,
        },
      })),
    });
  }

  /** Which tier's legend to show, by current zoom. */
  activeLevel(): "district" | "neighborhood" {
    return this.map.getZoom() < NB_IN ? "district" : "neighborhood";
  }
  activeScale(): Scale | null {
    return this.activeLevel() === "district" ? this.dScale : this.nbScale;
  }
  metric(): Metric {
    return this.lastMetric;
  }
}

export { DRILL_ZOOM, NB_IN };
