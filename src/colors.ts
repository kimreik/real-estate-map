// Sequential colour ramp (ColorBrewer YlOrRd, 6 classes) + quantile binning.
// We compute the colour for each district in JS and push it via setFeatureState,
// which keeps the MapLibre paint expression trivial.
const RAMP = ["#ffffb2", "#fed976", "#feb24c", "#fd8d3c", "#f03b20", "#bd0026"];

export interface Scale {
  breaks: number[]; // upper bounds, length = RAMP.length - 1
  colorFor(value: number): string;
  legend(): { color: string; from: number; to: number | null }[];
}

/** Build a quantile scale from the current set of district values. */
export function quantileScale(values: number[]): Scale {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const breaks: number[] = [];
  if (sorted.length) {
    for (let i = 1; i < RAMP.length; i++) {
      breaks.push(sorted[Math.floor((i / RAMP.length) * (sorted.length - 1))]);
    }
  }
  const colorFor = (value: number): string => {
    for (let i = 0; i < breaks.length; i++) {
      if (value <= breaks[i]) return RAMP[i];
    }
    return RAMP[RAMP.length - 1];
  };
  const legend = () =>
    RAMP.map((color, i) => ({
      color,
      from: i === 0 ? sorted[0] ?? 0 : breaks[i - 1],
      to: i < breaks.length ? breaks[i] : null,
    }));
  return { breaks, colorFor, legend };
}
