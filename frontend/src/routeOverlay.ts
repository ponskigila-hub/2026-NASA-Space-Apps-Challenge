import type { RouteOverlay, TerrainRoute } from './analysisApi';

export interface Segment {
  label: string;
  color: string;
  startKm: number;
  endKm: number;
}

export function pointAt(route: TerrainRoute, km: number) {
  const index = route.profile.findIndex(sample => sample.distanceKm >= km);
  if (index <= 0) return index === 0 ? route.path[0] : route.path.at(-1)!;
  const { point: a, distanceKm: start } = route.profile[index - 1];
  const { point: b, distanceKm: end } = route.profile[index];
  const fraction = (km - start) / (end - start);
  return { lat: a.lat + (b.lat - a.lat) * fraction, lon: a.lon + (b.lon - a.lon) * fraction };
}

export function mapOverlay(route: TerrainRoute, segments: Segment[]): RouteOverlay[] {
  return segments.map(({ color, startKm, endKm }) => ({
    color,
    points: [pointAt(route, startKm), ...route.profile.filter(sample =>
      sample.distanceKm > startKm && sample.distanceKm < endKm).map(sample => sample.point), pointAt(route, endKm)],
  }));
}
