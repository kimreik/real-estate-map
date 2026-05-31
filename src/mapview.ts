import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Metric, Tx } from "./types";
import { metricValue, type DistrictStat } from "./aggregate";
import { quantileScale, type Scale } from "./colors";

// Zoom where the district choropleth gives way to the in-district drill-down
// (heatmap of concentration, then individual points as you go deeper).
const DRILL_ZOOM = 12.5;
const POINT_ZOOM = 14; // individual clickable sales appear here
const WARSAW: [number, number] = [21.01, 52.23];

const CARTO_ATTRIB =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>';

export class MapView {
  readonly map: maplibregl.Map;
  private districts: GeoJSON.FeatureCollection;
  private ready = false;
  private onReady: (() => void)[] = [];
  private lastScale: Scale | null = null;
  private lastMetric: Metric = "count";

  constructor(container: string, districts: GeoJSON.FeatureCollection) {
    this.districts = districts;
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

  private init() {
    // --- District choropleth: colour baked into feature props by setChoropleth() ---
    this.map.addSource("districts", { type: "geojson", data: this.districts });
    this.map.addLayer({
      id: "district-fill",
      type: "fill",
      source: "districts",
      paint: {
        "fill-color": ["coalesce", ["get", "fillColor"], "rgba(0,0,0,0)"],
        "fill-opacity": [
          "interpolate", ["linear"], ["zoom"],
          DRILL_ZOOM - 1, 0.72,
          DRILL_ZOOM, 0.0,
        ],
      },
    });
    this.map.addLayer({
      id: "district-border",
      type: "line",
      source: "districts",
      paint: {
        "line-color": "#555",
        "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.6, 13, 1.4],
      },
    });

    // --- Drill-down: a plain (non-clustered) point source feeding a heatmap + circles ---
    this.map.addSource("points", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
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
          0.2, "#fed976",
          0.4, "#feb24c",
          0.6, "#fd8d3c",
          0.8, "#f03b20",
          1, "#bd0026",
        ],
        // fade the heatmap out as individual points take over
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
    // --- District hover tooltip (only while the choropleth is the active view) ---
    // Reposition on every move (cheap), but only rebuild the HTML when the hovered
    // district actually changes — rebuilding it every mousemove caused flicker.
    const tip = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      className: "district-tip",
      anchor: "bottom-left", // fixed anchor: no orientation flips as it follows the cursor
      offset: 12,
    });
    const plnFmt = new Intl.NumberFormat("pl-PL");
    let hovered: string | null = null;
    this.map.on("mousemove", "district-fill", (e) => {
      if (this.map.getZoom() >= DRILL_ZOOM) {
        if (hovered) { tip.remove(); hovered = null; }
        return;
      }
      const p = e.features?.[0]?.properties as { name?: string; count?: number; avgPpm2?: number | null } | undefined;
      if (!p?.name) return;
      this.map.getCanvas().style.cursor = "pointer";
      tip.setLngLat(e.lngLat);
      if (p.name !== hovered) {
        hovered = p.name;
        const avg = p.avgPpm2 != null && (p.avgPpm2 as unknown) !== "null"
          ? `${plnFmt.format(Number(p.avgPpm2))} zł/m²`
          : "—";
        tip.setHTML(`<strong>${p.name}</strong><br>${plnFmt.format(Number(p.count ?? 0))} matches<br>avg ${avg}`);
        if (!tip.isOpen()) tip.addTo(this.map);
      }
    });
    this.map.on("mouseleave", "district-fill", () => {
      this.map.getCanvas().style.cursor = "";
      tip.remove();
      hovered = null;
    });

    this.map.on("click", "point", (e) => {
      const p = e.features?.[0]?.properties;
      if (!p) return;
      const fmt = (n: number) => new Intl.NumberFormat("pl-PL").format(n);
      const has = (v: unknown) => v !== null && v !== undefined && v !== "" && v !== "null";
      const isHouse = p.kind === "house";
      const area = has(p.area) ? `${p.area} m²` : "—";
      const ppm2 = has(p.ppm2) ? `${fmt(Number(p.ppm2))} zł/m²` : "—";
      // Houses never carry a room count in RCN, so omit that slot for them.
      const roomLabel = has(p.izby) ? `${p.izby} room${Number(p.izby) === 1 ? "" : "s"}` : "—";
      const rooms = isHouse ? "" : `${roomLabel} · `;
      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(
          `<strong>${isHouse ? "House" : "Flat"}</strong> · ${p.district ?? ""}<br>` +
            `${fmt(Number(p.price))} zł · ${area} · ${ppm2}<br>${rooms}sold ${p.date}`,
        )
        .addTo(this.map);
    });
    this.map.on("mouseenter", "point", () => (this.map.getCanvas().style.cursor = "pointer"));
    this.map.on("mouseleave", "point", () => (this.map.getCanvas().style.cursor = ""));
  }

  /** Recolour districts for the chosen metric and stash per-district stats for the hover tooltip. */
  setChoropleth(stats: Map<string, DistrictStat>, metric: Metric) {
    this.lastMetric = metric;
    const values: number[] = [];
    for (const s of stats.values()) {
      const v = metricValue(s, metric);
      if (v !== undefined && Number.isFinite(v)) values.push(v);
    }
    const scale = quantileScale(values);
    this.lastScale = scale;
    for (const f of this.districts.features) {
      const props = f.properties as {
        name: string;
        fillColor?: string;
        count?: number;
        avgPpm2?: number | null;
      };
      const s = stats.get(props.name);
      const v = s ? metricValue(s, metric) : undefined;
      props.fillColor = v === undefined ? "rgba(0,0,0,0)" : scale.colorFor(v);
      props.count = s?.count ?? 0;
      props.avgPpm2 = s?.avgPpm2 ?? null;
    }
    (this.map.getSource("districts") as maplibregl.GeoJSONSource | undefined)?.setData(this.districts);
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
          price: t.price,
          area: t.area,
          ppm2: t.ppm2,
          izby: t.izby,
          kind: t.kind,
          district: t.district,
          date: t.date,
        },
      })),
    });
  }

  scale(): Scale | null {
    return this.lastScale;
  }
  metric(): Metric {
    return this.lastMetric;
  }
}

export { DRILL_ZOOM };
