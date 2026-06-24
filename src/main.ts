import "./style.css";
import { loadDataset, loadAreas } from "./data";
import { buildControls } from "./controls";
import { areaStats, filterTxs } from "./aggregate";
import { MapView } from "./mapview";

async function boot() {
  const panel = document.getElementById("panel")!;
  const [ds, districts, neighborhoods] = await Promise.all([
    loadDataset(),
    loadAreas("districts.geojson"),
    loadAreas("neighborhoods.geojson"),
  ]);

  const view = new MapView("map", districts, neighborhoods);

  let raf = 0;
  const controls = buildControls(panel, ds, () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      update();
    });
  });

  function refreshLegend() {
    const scale = view.activeScale();
    if (scale) controls.setLegend(scale.legend(), controls.metric, view.activeLevel());
  }

  function update() {
    const filtered = filterTxs(ds.txs, controls.state);
    view.setChoropleth(
      areaStats(filtered, (t) => t.district),
      areaStats(filtered, (t) => t.msi),
      controls.metric,
    );
    view.setPoints(filtered);
    controls.setResultCount(filtered.length);
    refreshLegend();
  }

  view.whenReady(() => {
    update();
    // The legend follows the active tier, which depends on zoom.
    let prevLevel = view.activeLevel();
    view.map.on("zoom", () => {
      if (view.activeLevel() !== prevLevel) {
        prevLevel = view.activeLevel();
        refreshLegend();
      }
    });
  });
}

boot().catch((err) => {
  console.error(err);
  document.getElementById("panel")!.innerHTML =
    `<p style="color:#b00;padding:1rem">Failed to load: ${err.message}</p>`;
});
