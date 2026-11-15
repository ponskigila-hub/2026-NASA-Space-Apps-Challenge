import type { EarthLight, LightFrame, LunarLight, ShadowState, TerrainRoute } from './analysisApi';
import type { Point } from './lunar';
import type { Segment } from './routeOverlay';

// These are the criteria used by backend/src/lighting.py for both live and saved windows.
export const lightingTargets = { elevationDeg: 2, shadowFraction: .1, coverage: .95 } as const;
export const shadowStyle = {
  0: { label: 'Sunlit', color: '#ffd273' },
  1: { label: 'Shadow', color: '#a899ff' },
  '-1': { label: 'Unknown', color: '#929a9d' },
};

type ShadowSegment = Segment & { state: ShadowState };
export type ObservationWindow = EarthLight['windows'][number];

export function shadowSegments(route: TerrainRoute, indices?: number[], states?: ShadowState[]): ShadowSegment[] {
  if (!indices?.length || !states || indices.length !== states.length || route.lengthKm <= 0) return [];
  const distances = indices.map(index => route.profile[index]?.distanceKm);
  if (distances.some((d, i) => !Number.isFinite(d) || d < 0 || d > route.lengthKm || (i > 0 && d <= distances[i - 1]))) return [];

  // Match the distance weights used by the terrain horizon model.
  const boundaries = [0, ...distances.slice(1).map((d, i) => (d + distances[i]) / 2), route.lengthKm];
  return states.reduce<ShadowSegment[]>((segments, rawState, index) => {
    const state = rawState === 0 || rawState === 1 ? rawState : -1;
    const last = segments.at(-1);
    if (last?.state === state) last.endKm = boundaries[index + 1];
    else segments.push({ ...shadowStyle[state], state, startKm: boundaries[index], endKm: boundaries[index + 1] });
    return segments;
  }, []);
}

export function shadowStatistics(segments: ShadowSegment[]) {
  if (!segments.some(segment => segment.state !== -1)) return undefined;
  let longestKm = 0;
  let transitions = 0;
  segments.forEach(({ state, startKm, endKm }, index) => {
    if (state === 1) {
      longestKm = Math.max(longestKm, endKm - startKm);
      if (segments[index - 1]?.state === 0) transitions += 1;
    }
  });
  return { longestKm, transitions };
}

export function angleGap(first?: number, second?: number) {
  if (first === undefined || second === undefined) return undefined;
  const gap = Math.abs(first - second) % 360;
  return Math.min(gap, 360 - gap);
}

const radians = (degrees: number) => degrees * Math.PI / 180;

function bearing(from: Point, to: Point) {
  const a = radians(from.lat);
  const b = radians(to.lat);
  const dl = radians(to.lon - from.lon);
  return Math.atan2(Math.sin(dl) * Math.cos(b), Math.cos(a) * Math.sin(b) - Math.sin(a) * Math.cos(b) * Math.cos(dl)) * 180 / Math.PI;
}

export function travelSunShares(route: TerrainRoute, azimuth?: number, elevation?: number) {
  if (azimuth === undefined || elevation === undefined || elevation <= 0) return undefined;
  const lengths = { toward: 0, across: 0, away: 0 };
  for (let i = 1; i < route.profile.length; i += 1) {
    const start = route.profile[i - 1];
    const end = route.profile[i];
    const length = end.distanceKm - start.distanceKm;
    if (length <= 0 || (start.point.lat === end.point.lat && start.point.lon === end.point.lon)) continue;
    const gap = angleGap(azimuth, bearing(start.point, end.point))!;
    lengths[gap <= 45 ? 'toward' : gap >= 135 ? 'away' : 'across'] += length;
  }
  const total = lengths.toward + lengths.across + lengths.away;
  return total > 0 ? { toward: lengths.toward / total, across: lengths.across / total, away: lengths.away / total } : undefined;
}

export function usableShadowShare(frame?: Partial<LightFrame>) {
  return frame?.coverage !== undefined && frame.coverage > 0 ? frame.shadowFraction : undefined;
}

export function lightingGaps(moon?: Partial<LightFrame> | null, earth?: LightFrame) {
  const lunarShadow = usableShadowShare(moon ?? undefined);
  const earthShadow = usableShadowShare(earth);
  return {
    elevationDeg: moon?.elevationDeg !== undefined && earth ? Math.abs(moon.elevationDeg - earth.elevationDeg) : undefined,
    azimuthDeg: angleGap(moon?.azimuthDeg, earth?.azimuthDeg),
    shadowFraction: lunarShadow !== undefined && earthShadow !== undefined ? Math.abs(lunarShadow - earthShadow) : undefined,
  };
}

export function meetsLightingTargets(moon: LunarLight | null | undefined, frame: LightFrame) {
  const gaps = lightingGaps(moon, frame);
  return moon?.status === 'available' && frame.elevationDeg > 0 && frame.coverage >= lightingTargets.coverage
    && gaps.elevationDeg !== undefined && gaps.elevationDeg <= lightingTargets.elevationDeg
    && gaps.shadowFraction !== undefined && gaps.shadowFraction <= lightingTargets.shadowFraction;
}

export function observationCsv(site: string, moon: LunarLight | null | undefined, window: ObservationWindow, selectedFrame: number) {
  const rows = [[
    'earth_site', 'earth_time_zone', 'lunar_scenario_utc', 'window_start_local', 'window_end_local', 'window_start_utc', 'window_end_utc',
    'earth_time_local', 'earth_time_utc', 'selected_preview', 'best_window_frame',
    'lunar_sun_elevation_deg', 'earth_sun_elevation_deg', 'sun_elevation_gap_deg',
    'lunar_sun_azimuth_deg', 'earth_sun_azimuth_deg', 'sun_azimuth_gap_deg',
    'lunar_shadow_percent', 'earth_shadow_percent', 'shadow_gap_percentage_points', 'earth_known_coverage_percent',
    'max_sun_elevation_gap_deg', 'max_shadow_gap_percentage_points', 'min_earth_known_coverage_percent', 'meets_lighting_targets',
  ]];
  function decimal(value?: number, scale = 1) {
    return value === undefined ? '' : (value * scale).toFixed(6);
  }
  window.frames.forEach((frame, index) => {
    const gaps = lightingGaps(moon, frame);
    rows.push([
      site, window.timeZone, moon?.utc ?? '', window.startLocal, window.endLocal, window.startUtc, window.endUtc,
      frame.local, frame.utc, String(index === selectedFrame), String(index === window.bestFrame),
      decimal(moon?.elevationDeg), decimal(frame.elevationDeg), decimal(gaps.elevationDeg),
      decimal(moon?.azimuthDeg), decimal(frame.azimuthDeg), decimal(gaps.azimuthDeg),
      decimal(usableShadowShare(moon ?? undefined), 100), decimal(frame.shadowFraction, 100), decimal(gaps.shadowFraction, 100), decimal(frame.coverage, 100),
      String(lightingTargets.elevationDeg), String(lightingTargets.shadowFraction * 100),
      String(lightingTargets.coverage * 100), String(meetsLightingTargets(moon, frame)),
    ]);
  });
  return rows.map(row => row.map(value => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value).join(',')).join('\r\n') + '\r\n';
}
