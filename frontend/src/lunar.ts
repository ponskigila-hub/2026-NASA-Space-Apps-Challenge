export interface Point {
  lat: number;
  lon: number;
}

export type Endpoint = 'A' | 'B';
export type Endpoints = Record<Endpoint, Point | null>;

export interface ProfileSample {
  point: Point;
  distanceKm: number;
  elevationM: number;
  slopeDeg: number;
  gradeDeg: number;
  roughnessM: number;
}

export interface RouteResult {
  kind: 'direct' | 'terrain';
  directKm: number;
  path: Point[];
  lengthKm: number | null;
  ascentM: number | null;
  descentM: number | null;
  steepestDeg: number | null;
  profile: ProfileSample[];
  explanation: string;
}

const RADIUS_KM = 1737.4;
const radians = Math.PI / 180;
export const HADLEY_CENTER: Point = { lat: 26.25, lon: 3.72 };
export const HADLEY_EXAMPLE: Record<Endpoint, Point> = {
  A: { lat: 26.143017, lon: 3.079142 },
  B: { lat: 26.357301, lon: 4.389023 },
};

export function lunarDistance(a: Point, b: Point) {
  const haversine = Math.sin((b.lat - a.lat) * radians / 2) ** 2
    + Math.cos(a.lat * radians) * Math.cos(b.lat * radians)
    * Math.sin((b.lon - a.lon) * radians / 2) ** 2;
  return 2 * RADIUS_KM * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

export function formatPoint(point: Point, digits = 4) {
  const lat = Math.abs(point.lat).toFixed(digits);
  const lon = Math.abs(point.lon).toFixed(digits);
  return `${lat}° ${point.lat < 0 ? 'S' : 'N'} / ${lon}° ${point.lon < 0 ? 'W' : 'E'}`;
}

function globeVector({ lat, lon }: Point) {
  return [
    Math.cos(lat * radians) * Math.cos(lon * radians),
    Math.cos(lat * radians) * Math.sin(lon * radians),
    Math.sin(lat * radians),
  ];
}

function directPath(a: Point, b: Point, angle: number) {
  const origin = globeVector(a);
  const destination = globeVector(b);
  const cosine = Math.cos(angle);
  let tangent = destination.map((value, index) => value - cosine * origin[index]);
  if (Math.hypot(...tangent) < 1e-12) {
    tangent = [-Math.sin(a.lon * radians), Math.cos(a.lon * radians), 0];
  }
  const magnitude = Math.hypot(...tangent);
  const path = [a];
  for (let index = 1; index < 96; index++) {
    const t = angle * index / 96;
    const [x, y, z] = origin.map((value, axis) =>
      value * Math.cos(t) + tangent[axis] / magnitude * Math.sin(t),
    );
    path.push({ lat: Math.atan2(z, Math.hypot(x, y)) / radians, lon: Math.atan2(y, x) / radians });
  }
  return [...path, b];
}

export function previewRoute(a: Point, b: Point): RouteResult {
  const directKm = lunarDistance(a, b);
  return {
    kind: 'direct', directKm, path: directPath(a, b, directKm / RADIUS_KM),
    lengthKm: null, ascentM: null, descentM: null, steepestDeg: null, profile: [],
    explanation: 'Direct distance on the lunar sphere.',
  };
}
