import "./style.css";
import { loadDataset, loadDistricts } from "./data";
import { buildControls } from "./controls";
import { districtStats, filterTxs } from "./aggregate";
import { MapView } from "./mapview";

async function boot() {
  const panel = document.getElementById("panel")!;
  const [ds, districts] = await Promise.all([loadDataset(), loadDistricts()]);

  const view = new MapView("map", districts);

  let raf = 0;
  const controls = buildControls(panel, ds, () => {
    // Coalesce rapid slider events into one update per frame.
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      update();
    });
  });

  function update() {
    const filtered = filterTxs(ds.txs, controls.state);
    const stats = districtStats(filtered);
    view.setChoropleth(stats, controls.metric);
    view.setPoints(filtered);
    controls.setResultCount(filtered.length);
    const scale = view.scale();
    if (scale) controls.setLegend(scale.legend(), controls.metric);
  }

  view.whenReady(update);
}

boot().catch((err) => {
  console.error(err);
  document.getElementById("panel")!.innerHTML =
    `<p style="color:#b00;padding:1rem">Failed to load: ${err.message}</p>`;
});
