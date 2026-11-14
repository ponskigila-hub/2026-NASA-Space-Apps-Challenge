import type { Point, ProfileSample, RouteResult } from './lunar';

export const presets = {
  rover_navigation: 'Rover navigation',
  camera_lighting: 'Camera / lighting',
  mineral_mapping: 'Mineral mapping',
} as const;
export type Preset = keyof typeof presets;

interface Evidence {
  coverage: number | null;
  confidence: string;
  sourceIds: string[];
  analysisResolutionM: number;
  confidenceBasis: string;
}

export interface TerrainRoute {
  path: Point[];
  lengthKm: number;
  ascentM: number;
  descentM: number;
  steepestDeg: number;
  profile: ProfileSample[];
  corridor: { coverage: number; halfWidthM: number };
}

export interface Candidate {
  id: string;
  name: string;
  location: string;
  description: string;
  center: Point;
  bounds: [number, number, number, number];
  evidence: Evidence;
  status: 'matched' | 'unevaluable';
  reason?: string;
  rank?: number;
  score?: number;
  featureScores?: { slope: number; roughness: number };
  route?: TerrainRoute;
  lighting?: EarthLight | null;
  minerals?: MineralEvidence | null;
}

export interface Analysis {
  id: string;
  mode: 'live' | 'replay';
  fetchedSite?: string;
  preset: Preset;
  dataVersion: string;
  effectiveWeights: Weights;
  rankings?: Record<Preset, { weights: Weights; sharedBands: string[];
    sites: Record<string, { score: number; rank: number }> }>;
  lighting?: LunarLight | null;
  minerals?: MineralEvidence | null;
  directKm: number;
  lunar: TerrainRoute & { evidence: Evidence };
  candidates: Candidate[];
  endpoints: Record<'A' | 'B', { requested: Point; snapped: Point; snapDistanceM: number }>;
  sources: { id: string; url: string; version: string; kind: string }[];
  limitations: string[];
}

type Job =
  | { id: string; status: 'queued' | 'running' }
  | { id: string; status: 'complete'; result: Analysis }
  | { id: string; status: 'failed'; error: { message: string } };

const api = (import.meta.env.VITE_ASTROSCAN_API_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const base = import.meta.env.BASE_URL;

async function json<T>(url: string, options: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error('The analysis service is unavailable. Start the local backend or load a replay case.');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.detail?.message || body?.detail?.[0]?.msg || 'The analysis could not load. Try again or load a replay case.');
  }
  return response.json();
}

export async function analyze(a: Point, b: Point, preset: Preset, lunarUtc: string, earthStart: string, signal: AbortSignal) {
  let job = await json<Job>(`${api}/analyses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ a, b, preset, lunarUtc, earthStart }), signal,
  });
  for (let count = 0; count < 315; count++) {
    if (job.status === 'complete') return job.result;
    if (job.status === 'failed') throw new Error(job.error.message);
    await new Promise(resolve => window.setTimeout(resolve, 800));
    signal.throwIfAborted();
    job = await json<Job>(`${api}/analyses/${job.id}`, { signal });
  }
  throw new Error('The analysis took too long. Try again or load a replay case.');
}

export type Replay = 'hadley' | 'rille';

export function replay(kind: Replay, signal: AbortSignal) {
  return json<Analysis>(`${base}replay/${kind}/analysis.json`, { signal });
}

export function reportUrl(result: Analysis, site: string | null, replayCase: Replay | null) {
  if (replayCase) {
    return `${base}replay/${replayCase}/${result.preset}-${site ?? 'overview'}.zip`;
  }
  const parameters = new URLSearchParams({ preset: result.preset });
  if (site) parameters.set('site', site);
  return `${api}/analyses/${result.id}/report?${parameters}`;
}

export function terrainRoute(result: Analysis): RouteResult {
  return {
    ...result.lunar, kind: 'terrain', directKm: result.directKm,
    explanation: `Lunar DEM on a 90 m grid. ${(result.lunar.corridor.coverage * 100).toFixed(1)}% valid corridor coverage.`,
  };
}

export const defaultLunarUtc = '2026-11-18T00:00';
export const defaultEarthStart = () => new Date().toISOString().slice(0, 10);
export type ShadowState = -1 | 0 | 1;

export interface LightFrame {
  utc: string;
  local: string;
  elevationDeg: number;
  azimuthDeg: number;
  shadowFraction: number;
  coverage: number;
  states: ShadowState[];
}
export interface LunarLight extends Partial<LightFrame> {
  status: 'available' | 'unavailable';
  reason?: string;
  earthStart?: string;
  earthDays?: number;
  method?: string;
  sampleIndices?: number[];
}
export interface EarthLight {
  score: number | null;
  reason?: string;
  sampleIndices?: number[];
  windows: { startUtc: string; endUtc: string; startLocal: string; endLocal: string; timeZone: string;
    frames: LightFrame[]; bestFrame: number }[];
}
export interface SpectralPoint {
  nm: number;
  median: number | null;
  p25?: number;
  p75?: number;
  pixels?: number;
}
export interface MineralEvidence {
  lithology?: { coverage: number; units: { name: string; fraction: number }[];
    segments: { unit: string; startKm: number; endKm: number }[] };
  spectral: { status: string; reason?: string; scene?: string; url?: string;
    spectrum?: SpectralPoint[];
    sampleDistancesKm?: number[];
    bandSupport?: Record<string, boolean[]>;
    bands?: Record<string, { medianDepth: number; medianCenterNm: number; coverage: number; independentPixels: number }> };
  bandScores?: Record<string, number>;
}
export interface RouteOverlay { points: Point[]; color: string }
type Weights = Partial<Record<'slope' | 'roughness' | 'lighting' | 'mineral', number>>;

export function applyPreset(result: Analysis, preset: Preset): Analysis {
  const ranking = result.rankings?.[preset];
  if (!ranking) return { ...result, preset };
  return {
    ...result, preset, effectiveWeights: ranking.weights,
    candidates: result.candidates.map(site => ({ ...site, ...ranking.sites[site.id] }))
      .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.id.localeCompare(b.id)),
  };
}

export async function fetchMinerals(result: Analysis, site: string, signal: AbortSignal, progress: (message: string) => void) {
  const { id } = await json<{ id: string }>(`${api}/analyses/${result.id}/emit/${encodeURIComponent(site)}`, { method: 'POST', signal });
  while (!signal.aborted) {
    const job = await json<{ status: 'running' | 'failed'; message: string } | { status: 'complete'; result: Analysis }>(
      `${api}/emit/${id}`, { signal });
    if (job.status === 'complete') return applyPreset(job.result, result.preset);
    if (job.status === 'failed') throw new Error(job.message);
    progress(job.message);
    await new Promise(resolve => window.setTimeout(resolve, 1500));
  }
  signal.throwIfAborted();
  throw new Error('EMIT polling stopped.');
}
