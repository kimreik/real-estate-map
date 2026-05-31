import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Metric, Tx } from "./types";
import { quantileScale, type Scale } from "./colors";

// Zoom at which we switch from the district choropleth to individual points.
const DRILL_ZOOM = 12.5;
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
    // --- District choropleth (name promoted to feature id for setFeatureState) ---
    this.map.addSource("districts", {
      type: "geojson",
      data: this.districts,
    });
    this.map.addLayer({
      id: "district-fill",
      type: "fill",
      source: "districts",
      paint: {
        // Colour is baked into each feature's properties by setChoropleth() and
        // pushed via setData() — deterministic for 18 polygons, no feature-state timing.
        "fill-color": ["coalesce", ["get", "fillColor"], "rgba(0,0,0,0)"],
        "fill-opacity": [
          // fade the choropleth out as we zoom into drill-down range
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
      paint: { "line-color": "#555", "line-width": 1 },
    });

    // --- Points (clustered) for the drill-down ---
    this.map.addSource("points", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      cluster: true,
      clusterRadius: 55,
      clusterMaxZoom: 16,
    });
    this.map.addLayer({
      id: "clusters",
      type: "circle",
      source: "points",
      filter: ["has", "point_count"],
      minzoom: DRILL_ZOOM,
      paint: {
        "circle-color": "#3b6ea5",
        "circle-opacity": 0.85,
        "circle-radius": ["step", ["get", "point_count"], 14, 25, 20, 100, 28, 500, 36],
      },
    });
    this.map.addLayer({
      id: "cluster-count",
      type: "symbol",
      source: "points",
      filter: ["has", "point_count"],
      minzoom: DRILL_ZOOM,
      layout: {
        "text-field": ["get", "point_count_abbreviated"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 12,
      },
      paint: { "text-color": "#fff" },
    });
    this.map.addLayer({
      id: "point",
      type: "circle",
      source: "points",
      filter: ["!", ["has", "point_count"]],
      minzoom: DRILL_ZOOM,
      paint: {
        "circle-color": ["case", ["==", ["get", "kind"], "house"], "#2e7d32", "#c62828"],
        "circle-radius": 5,
        "circle-stroke-width": 1,
        "circle-stroke-color": "#fff",
        "circle-opacity": 0.85,
      },
    });

    this.wireInteractions();
    this.ready = true;
    this.onReady.forEach((cb) => cb());
  }

  private wireInteractions() {
    // Click a cluster -> zoom into it.
    this.map.on("click", "clusters", async (e) => {
      const feat = this.map.queryRenderedFeatures(e.point, { layers: ["clusters"] })[0];
      const id = feat.properties?.cluster_id;
      const src = this.map.getSource("points") as maplibregl.GeoJSONSource;
      const zoom = await src.getClusterExpansionZoom(id);
      this.map.easeTo({ center: (feat.geometry as GeoJSON.Point).coordinates as [number, number], zoom });
    });

    // Single-point popup.
    this.map.on("click", "point", (e) => {
      const p = e.features?.[0]?.properties;
      if (!p) return;
      const fmt = (n: number) => new Intl.NumberFormat("pl-PL").format(n);
      const rooms = p.izby != null && p.izby !== "" ? `${p.izby} izby` : "—";
      const area = p.area && p.area !== "null" ? `${p.area} m²` : "—";
      const ppm2 = p.ppm2 && p.ppm2 !== "null" ? `${fmt(Number(p.ppm2))} zł/m²` : "—";
      new maplibregl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(
          `<strong>${p.kind === "house" ? "House" : "Flat"}</strong> · ${p.district ?? ""}<br>` +
            `${fmt(Number(p.price))} zł · ${area} · ${ppm2}<br>` +
            `${rooms} · sold ${p.date}`,
        )
        .addTo(this.map);
    });

    for (const layer of ["clusters", "point"]) {
      this.map.on("mouseenter", layer, () => (this.map.getCanvas().style.cursor = "pointer"));
      this.map.on("mouseleave", layer, () => (this.map.getCanvas().style.cursor = ""));
    }
  }

  /** Recolour districts for the given metric values. */
  setChoropleth(valuesByDistrict: Map<string, number>, metric: Metric) {
    this.lastMetric = metric;
    const scale = quantileScale([...valuesByDistrict.values()]);
    this.lastScale = scale;
    for (const f of this.districts.features) {
      const name = (f.properties as { name: string }).name;
      const v = valuesByDistrict.get(name);
      this.map.setFeatureState(
        { source: "districts", id: name },
        { color: v === undefined ? "rgba(0,0,0,0)" : scale.colorFor(v), value: v ?? null },
      );
    }
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
