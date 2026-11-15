import type { RouteOverlay, TerrainRoute } from './analysisApi';
import type { Point, ProfileSample } from './lunar';

export const terrainMetrics = {
  slopeDeg: { label: 'Slope', unit: '°', spokenUnit: 'degrees', boundaries: [0, 5, 10, 15, 20, 25] },
  roughnessM: { label: 'Roughness', unit: 'm', spokenUnit: 'metres', boundaries: [0, 1, 2, 4, 8, 16] },
} as const;

export type TerrainMetric = keyof typeof terrainMetrics;
export type TerrainMapOverlays = { moon: RouteOverlay[]; earth: RouteOverlay[] };
export const terrainHighlightColor = '#64ddd1';

interface RouteSection {
  sample: ProfileSample;
  start: Point;
  end: Point;
  lengthKm: number;
}

// A sample represents the route between the midpoints of its neighboring steps.
// The same sections determine both length percentages and map highlights.
export function routeSections({ profile }: TerrainRoute): RouteSection[] {
  const midpoints = profile.slice(1).map((sample, index) => {
    const previous = profile[index];
    const deltaLon = sample.point.lon - previous.point.lon;
    return {
      point: {
        lat: (sample.point.lat + previous.point.lat) / 2,
        lon: previous.point.lon + (deltaLon - 360 * Math.round(deltaLon / 360)) / 2,
      },
      distanceKm: (sample.distanceKm + previous.distanceKm) / 2,
    };
  });
  return profile.flatMap((sample, index) => {
    const start = midpoints[index - 1] ?? sample;
    const end = midpoints[index] ?? sample;
    const lengthKm = end.distanceKm - start.distanceKm;
    return Number.isFinite(lengthKm) && lengthKm > 0
      ? [{ sample, start: start.point, end: end.point, lengthKm }] : [];
  });
}

function measuredSections(sections: RouteSection[], metric: TerrainMetric) {
  return sections.filter(({ sample }) => Number.isFinite(sample[metric]) && sample[metric] >= 0);
}

export function terrainStatistics(sections: RouteSection[], metric: TerrainMetric, threshold?: number) {
  const measured = measuredSections(sections, metric).sort((a, b) => a.sample[metric] - b.sample[metric]);
  const length = measured.reduce((sum, section) => sum + section.lengthKm, 0);
  if (!length) return null;
  const mean = measured.reduce((sum, { sample, lengthKm }) => sum + sample[metric] * lengthKm, 0) / length;
  const variance = measured.reduce((sum, { sample, lengthKm }) => sum + (sample[metric] - mean) ** 2 * lengthKm, 0) / length;
  function percentile(fraction: number) {
    let cumulative = 0;
    for (const { sample, lengthKm } of measured) {
      cumulative += lengthKm;
      if (cumulative >= length * fraction) return sample[metric];
    }
    return measured.at(-1)!.sample[metric];
  }
  return {
    mean, median: percentile(.5), p90: percentile(.9), deviation: Math.sqrt(variance),
    above: threshold === undefined ? undefined : measured.reduce((sum, { sample, lengthKm }) =>
      sum + (sample[metric] > threshold ? lengthKm : 0), 0) / length,
  };
}

export function terrainDistribution(sections: RouteSection[], metric: TerrainMetric) {
  const { boundaries } = terrainMetrics[metric];
  const bins = boundaries.map(() => ({ length: 0, overlays: [] as RouteOverlay[] }));
  let measuredLength = 0;
  let previous: RouteSection | undefined;
  let previousBin = -1;
  for (const section of measuredSections(sections, metric)) {
    const index = boundaries.findIndex((_, i) => section.sample[metric] < (boundaries[i + 1] ?? Infinity));
    const bin = bins[index];
    bin.length += section.lengthKm;
    measuredLength += section.lengthKm;
    if (previous?.end === section.start && previousBin === index) {
      bin.overlays.at(-1)!.points.push(section.sample.point, section.end);
    } else {
      bin.overlays.push({ points: [section.start, section.sample.point, section.end], color: terrainHighlightColor });
    }
    previous = section;
    previousBin = index;
  }
  return bins.map(({ length, overlays }) => ({ share: measuredLength ? length / measuredLength : null, overlays }));
}
