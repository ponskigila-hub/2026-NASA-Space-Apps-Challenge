import L from 'leaflet';
import { ArrowUpRight, Crosshair, Download, Globe2, MapPin, Minus, Plus } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { analyze, customImageryUrl, defaultEarthStart, defaultLunarUtc, getEarthSites, presets, reportUrl, type Analysis, type Candidate, type EarthSite, type Replay, type RouteOverlay, type TerrainRoute } from './analysisApi';
import AnalysisLoading from './AnalysisLoading';
import { Takeaway } from './MissionSummary';
import { EvidenceQuality, RankingStability, WhyThisSite } from './ResearchEvidence';
import { rankedFeatures, rankingFeatureScores } from './rankingEvidence';
import RouteScience from './RouteScience';
import TerrainComparison from './TerrainComparison';
import type { TerrainMapOverlays } from './terrainDistribution';
import earthLand from './data/earth-land.json';
import earthRoutes from './data/earth-routes.json';
import type { Point, ProfileSample } from './lunar';

const mapBounds: L.LatLngBoundsExpression = [[-60, -180], [80, 180]];
const base = import.meta.env.BASE_URL;
const toLatLng = ({ lat, lon }: Point): L.LatLngTuple => [lat, lon];

function fitMap(map: L.Map, site: Candidate | null) {
  if (site?.route) map.fitBounds(L.latLngBounds(site.route.path.map(toLatLng)), { maxZoom: 13, padding: [26, 28] });
  else if (site) map.setView(toLatLng(site.center), 9);
  else map.fitBounds(mapBounds, { maxZoom: 3 });
}

function EarthMap({ candidates, site, onSelect, highlight, overlay, satellite, overlayControls }: {
  candidates: Candidate[];
  site: Candidate | null;
  onSelect: (id: string) => void;
  highlight: Point | null;
  overlay: RouteOverlay[];
  overlayControls?: ReactNode;
  satellite?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layers = useRef<L.LayerGroup | null>(null);
  const scienceLayer = useRef<L.LayerGroup | null>(null);
  const marker = useRef<L.CircleMarker | null>(null);
  const [imageReady, setImageReady] = useState(false);

  useEffect(() => {
    if (!container.current) return;
    const instance = L.map(container.current, {
      zoomControl: false, attributionControl: false, minZoom: 0, maxZoom: 15, zoomSnap: 0.25,
      maxBounds: [[-85.05, -180], [85.05, 180]], maxBoundsViscosity: 1,
    });
    map.current = instance;
    instance.createPane('earthLand').style.zIndex = '210';
    instance.createPane('earthImagery').style.zIndex = '220';
    L.geoJSON(earthLand as GeoJSON.FeatureCollection, {
      pane: 'earthLand', interactive: false, style: { color: '#606b4a', weight: 1, fillColor: '#353e2b', fillOpacity: 1 },
    }).addTo(instance);
    layers.current = L.layerGroup().addTo(instance);
    scienceLayer.current = L.layerGroup().addTo(instance);
    L.control.scale({ imperial: false, maxWidth: 90, position: 'bottomleft' }).addTo(instance);
    const observer = new ResizeObserver(() => instance.invalidateSize({ pan: false }));
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      instance.remove();
      map.current = null;
      layers.current = null;
    };
  }, []);

  const imagery = earthRoutes.find(item => item.id === site?.id);
  useEffect(() => {
    const instance = map.current;
    const group = layers.current;
    if (!instance || !group) return;
    setImageReady(false);
    group.clearLayers();
    if (site) {
      const [west, south, east, north] = site.bounds;
      if (east > west && north > south) {
        L.imageOverlay(site.relief ?? `${base}terrain/${site.id}-relief.webp`, [[south, west], [north, east]], { alt: '', pane: 'earthImagery' })
          .addTo(group);
      }
      if (imagery) {
        const [west, south, east, north] = imagery.bounds;
        L.imageOverlay(`${base}earth/${site.id}.webp`, [[south, west], [north, east]], { alt: '', pane: 'earthImagery' })
          .on('load', () => setImageReady(true)).addTo(group);
      } else if (satellite && site.relief) {
        L.imageOverlay(satellite, [[south, west], [north, east]], { alt: '', pane: 'earthImagery' })
          .on('load', () => setImageReady(true)).addTo(group);
      }
      if (site.route) {
        const path = site.route.path.map(toLatLng);
        L.polyline(path, { color: '#171a13', weight: 7, interactive: false }).addTo(group);
        L.polyline(path, { color: '#e1f78e', weight: 3, interactive: false }).addTo(group);
        [path[0], path[path.length - 1]].forEach((position, index) => {
          const letter = index === 0 ? 'A' : 'B';
          const label = index === 0 ? 'Start of Earth route' : 'End of Earth route';
          const icon = L.divIcon({ className: `lunar-pin lunar-pin-${letter.toLowerCase()}`,
            html: `<span aria-hidden="true">${letter}</span>`, iconSize: [31, 31], iconAnchor: [15, 15] });
          L.marker(position, { icon, title: label, alt: label }).addTo(group).bindTooltip(label);
        });
      }
    } else {
      for (const candidate of candidates) {
        const icon = L.divIcon({ className: 'earth-overview-pin', iconSize: [16, 16], iconAnchor: [8, 8] });
        L.marker(toLatLng(candidate.center), { icon, title: candidate.name, alt: candidate.name })
          .addTo(group).bindTooltip(candidate.name).on('click', () => onSelect(candidate.id));
      }
    }
    fitMap(instance, site);
    return () => { group.clearLayers(); };
  }, [site, imagery, candidates, onSelect, satellite]);

  useEffect(() => {
    const layer = scienceLayer.current;
    if (!layer) return;
    layer.clearLayers();
    overlay.forEach(section => L.polyline(section.points.map(toLatLng), { color: section.color, weight: 5, interactive: false }).addTo(layer));
  }, [overlay, site]);

  useEffect(() => {
    marker.current?.remove();
    if (!highlight || !site?.route || !map.current) return;
    marker.current = L.circleMarker(toLatLng(highlight), {
      radius: 7, color: '#f5f4e9', weight: 2, fillColor: '#e1f78e', fillOpacity: 1, interactive: false,
    }).addTo(map.current);
    return () => { marker.current?.remove(); };
  }, [highlight, site]);

  return (
    <section className="map-shell earth-map" aria-label="Earth analog map">
      <header className="map-header">
        <h3 id="earth-map-title"><Globe2 size={17} aria-hidden="true" /> {site?.name ?? 'Earth overview'}</h3>
        <span className="map-source">{site ? imageReady ? 'Satellite imagery and terrain relief' : site.bounds[0] === site.bounds[2] ? 'Terrain unavailable' : 'Shaded elevation map' : 'Analog sites'}</span>
      </header>
      <div className="map-stage">
        <div className="map-canvas" ref={container} role="region" aria-label={site ? `${site.name} route map` : 'Map of all Earth analog sites'} />
        <div className="map-controls">
          <div className="map-glass zoom-controls">
            <button type="button" aria-label="Zoom in on Earth map" onClick={() => map.current?.zoomIn()}><Plus size={18} /></button>
            <button type="button" aria-label="Zoom out on Earth map" onClick={() => map.current?.zoomOut()}><Minus size={18} /></button>
          </div>
          <button type="button" className="map-glass reset-map" aria-label="Reset Earth map view"
            onClick={() => { if (map.current) fitMap(map.current, site); }}><Crosshair size={18} /></button>
        </div>
        {overlayControls}
      </div>
      <footer className="map-footer">
        <span className="map-position"><MapPin size={13} /> {site?.location ?? `${candidates.length} Earth regions`}</span>
        <span className="map-credit">
          {imagery && imageReady ? <a href={imagery.imagery[0]} target="_blank" rel="noreferrer">Modified Copernicus Sentinel data 2024</a>
            : site?.relief && imageReady ? <a href="https://dataspace.copernicus.eu/" target="_blank" rel="noreferrer">Contains modified Copernicus Sentinel data</a>
            : site ? <a href="https://copernicus-dem-30m.s3.amazonaws.com/readme.html" target="_blank" rel="noreferrer">Copernicus DEM GLO-30</a>
              : <a href="https://www.naturalearthdata.com/" target="_blank" rel="noreferrer">Natural Earth</a>}
        </span>
      </footer>
    </section>
  );
}

const metrics = { elevationM: ['Relative elevation', 'm'], slopeDeg: ['Slope', '°'], roughnessM: ['Roughness', 'm'] } as const;
type Metric = keyof typeof metrics;

function interpolate(profile: ProfileSample[], distance: number, metric: Metric) {
  const next = profile.findIndex(sample => sample.distanceKm >= distance);
  if (next < 0) return undefined;
  const origin = metric === 'elevationM' ? profile[0].elevationM : 0;
  const end = profile[next];
  if (!next || end.distanceKm === distance) return end[metric] - origin;
  const start = profile[next - 1];
  const fraction = (distance - start.distanceKm) / (end.distanceKm - start.distanceKm);
  return start[metric] + fraction * (end[metric] - start[metric]) - origin;
}

function nearest(profile: ProfileSample[], distance: number) {
  if (distance > profile[profile.length - 1].distanceKm) return null;
  return profile.reduce((best, sample) =>
    Math.abs(sample.distanceKm - distance) < Math.abs(best.distanceKm - distance) ? sample : best).point;
}

function ComparisonProfile({ lunar, earth, name, onHighlight, onEarthHighlight }: {
  lunar: TerrainRoute;
  earth: TerrainRoute;
  name: string;
  onHighlight: (point: Point | null) => void;
  onEarthHighlight: (point: Point | null) => void;
}) {
  const [metric, setMetric] = useState<Metric>('elevationM');
  const [, unit] = metrics[metric];
  const series = useMemo(() => {
    const distances = new Set([...lunar.profile, ...earth.profile].map(sample => sample.distanceKm));
    return Array.from(distances).sort((a, b) => a - b).map(km => ({
      km, moon: interpolate(lunar.profile, km, metric), earth: interpolate(earth.profile, km, metric),
    }));
  }, [lunar, earth, metric]);
  const paired = series.filter(row => row.moon !== undefined && row.earth !== undefined);
  const gap = paired.reduce<(typeof series)[number] | undefined>((largest, row) =>
    !largest || Math.abs(row.moon! - row.earth!) > Math.abs(largest.moon! - largest.earth!) ? row : largest, undefined);
  const lowPoint = lunar.profile.reduce((lowest, sample) => sample.elevationM < lowest.elevationM ? sample : lowest);
  const lowOffset = lowPoint.elevationM - lunar.profile[0].elevationM;
  const precision = Math.max(lunar.lengthKm, earth.lengthKm) < 2 ? 2 : 1;
  return (
    <div className="profile earth-profile">
      <div className="profile-heading">
        <h3>Compare the Moon and Earth routes</h3>
        <div className="segmented" role="group" aria-label="Earth comparison metric">
          {(Object.keys(metrics) as Metric[]).map(key => <button key={key} type="button" aria-pressed={metric === key}
            onClick={() => setMetric(key)}>{key === 'elevationM' ? 'Elevation' : metrics[key][0]}</button>)}
        </div>
      </div>
      <Takeaway>Compare the two routes at the same distance from their starting points to see where the Earth route demands a similar climb or crosses similar ground.</Takeaway>
      <div className="earth-legend"><span>Hadley</span><span>{name}</span></div>
      <div className="chart-container" onMouseLeave={() => { onHighlight(null); onEarthHighlight(null); }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series} margin={{ top: 8, right: 15, bottom: 0, left: 0 }} onMouseMove={state => {
            const km = Number(state?.activeLabel);
            if (Number.isFinite(km)) {
              onHighlight(nearest(lunar.profile, km));
              onEarthHighlight(nearest(earth.profile, km));
            }
          }}>
            <CartesianGrid stroke="var(--line)" vertical={false} />
            <XAxis dataKey="km" type="number" domain={[0, 'dataMax']} tickFormatter={value => Number(value).toFixed(precision)}
              stroke="var(--muted)" tick={{ fontSize: 11 }} />
            <YAxis width={46} stroke="var(--muted)" tick={{ fontSize: 11 }} />
            <Tooltip labelFormatter={value => `${Number(value).toFixed(precision)} km`}
              formatter={value => `${Number(value).toFixed(1)} ${unit}`}
              contentStyle={{ background: 'var(--panel)', borderColor: 'var(--line)', borderRadius: 8, fontSize: 12 }} />
            {metric === 'elevationM' && lowOffset < 0 && <ReferenceDot x={lowPoint.distanceKm} y={lowOffset}
              r={5} fill="var(--mission-cyan)" stroke="var(--panel)" />}
            {metric === 'elevationM' && gap && <ReferenceDot x={gap.km} y={gap.moon!} r={6}
              fill="var(--mission-lime)" stroke="var(--panel)" label={{ value: 'Largest elevation gap', position: 'insideTopRight', fill: 'var(--ink)', fontSize: 13 }} />}
            <Line name="Hadley" dataKey="moon" stroke="var(--muted)" strokeDasharray="5 4" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line name={name} dataKey="earth" stroke="var(--accent)" strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {metric === 'elevationM' && gap && <div className="mission-callout">
        <strong>Where the profiles diverge</strong>
        <p>The largest elevation gap is <strong className="profile-gap-number">{Math.round(Math.abs(gap.moon! - gap.earth!)).toLocaleString()} m</strong> at <strong className="profile-gap-number">{gap.km.toFixed(2)} km</strong> from the start, measured relative to each route’s starting elevation.</p>
        {lowOffset < 0 && <p>The blue marker shows the Moon’s lowest point, <strong>{Math.round(-lowOffset).toLocaleString()} m below the start</strong> at <strong>{lowPoint.distanceKm.toFixed(2)} km</strong>.</p>}
      </div>}
      <p className="chart-caption">The horizontal axis is distance traveled in km. {metric === 'elevationM' ? 'Each line starts at zero. Positive values mean above that route’s start and negative values mean below it.' : metric === 'slopeDeg' ? 'The vertical axis shows how steep the ground is in degrees.' : 'The vertical axis shows local ground-height variation in meters. Higher values indicate bumpier ground.'}</p>
    </div>
  );
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

function EarthSiteList({ result, onUpdate, onRankingChange, children }: {
  result: Analysis;
  onUpdate: (analysis: Analysis) => void;
  onRankingChange: (ranking: boolean) => void;
  children: ReactNode;
}) {
  const [sites, setSites] = useState<EarthSite[]>([]);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const savedCenter = result.candidates.find(site => site.id === 'custom')?.center;
  const [latitude, setLatitude] = useState(savedCenter?.lat.toString() ?? '');
  const [longitude, setLongitude] = useState(savedCenter?.lon.toString() ?? '');
  const [pendingSites, setPendingSites] = useState<string[] | null>(null);
  const pending = pendingSites !== null;
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    setCatalogFailed(false);
    getEarthSites(controller.signal).then(catalog => {
      if (controller.signal.aborted) return;
      setSites(catalog);
    }).catch(() => {
      if (!controller.signal.aborted) setCatalogFailed(true);
    });
    return () => controller.abort();
  }, [catalogAttempt]);

  const candidates = new Map(result.candidates.map(site => [site.id, site]));
  const previewSites = sites.filter(site => !candidates.has(site.id));
  const needsEvaluation = previewSites.length > 0 || sites.some(site => {
    const candidate = candidates.get(site.id);
    return candidate && !candidate.relief;
  });

  const lat = Number(latitude);
  const lon = Number(longitude);
  const validCenter = latitude.trim() !== '' && longitude.trim() !== '' && lat >= -79 && lat <= 83 && lon >= -176 && lon <= 176;

  async function search(siteId?: string, customCenter?: Point) {
    if (pending || (!sites.length && !customCenter)) return;
    const earthSites = sites.filter(site => !siteId || site.id === siteId || candidates.has(site.id))
      .map(site => site.id);
    const controller = new AbortController();
    request.current = controller;
    setPendingSites(earthSites);
    onRankingChange(true);
    setError('');
    try {
      const updated = await analyze(result.endpoints.A.requested, result.endpoints.B.requested, result.preset,
        result.lighting?.utc ?? `${defaultLunarUtc}Z`, result.lighting?.earthStart ?? defaultEarthStart(), controller.signal,
        { earthSites, earthCenter: customCenter ?? savedCenter });
      if (!controller.signal.aborted) onUpdate(updated);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not compare Earth regions.');
    } finally {
      if (!controller.signal.aborted) {
        setPendingSites(null);
        onRankingChange(false);
      }
    }
  }

  if (pending) return <AnalysisLoading compact title="Ranking Earth sites"
    detail="Fetching elevation and calculating routes. Rankings appear once every site has been processed."
    estimate={pendingSites.length <= 1
      ? { seconds: 45, label: 'Estimated total · About 20–45 seconds' }
      : { seconds: 120, label: 'Estimated total · About 1–2 minutes' }} />;

  return <div className="earth-sites" aria-label="Earth analog sites" role="group">
    {needsEvaluation && <div className="analysis-actions">
      <button className="pick-button" type="button"
        onClick={() => void search()}>{previewSites.length ? 'Fetch and rank NASA sites' : 'Retry unavailable NASA sites'}</button>
    </div>}
    {error && <p className="earth-list-status" role="alert">{error}</p>}
    {catalogFailed ? <div className="analysis-actions">
      <button className="pick-button" type="button" onClick={() => setCatalogAttempt(attempt => attempt + 1)}>Retry NASA site list</button>
    </div> : sites.length === 0 && <p className="earth-list-status" role="status">Loading NASA sites…</p>}
    <form className="profile earth-custom-region" aria-labelledby="custom-region-title" onSubmit={event => {
      event.preventDefault();
      if (validCenter) void search(undefined, { lat, lon });
    }}>
      <h3 id="custom-region-title">Custom Earth region</h3>
      <p className="chart-caption">Enter a center point in decimal degrees to compare the surrounding terrain with your Moon route.</p>
      <div className="coordinate-inputs">
        <label>Latitude
          <input type="number" inputMode="decimal" min="-79" max="83" step="any" required value={latitude}
            onChange={event => setLatitude(event.target.value)} />
          <small>−79° to 83°</small>
        </label>
        <label>Longitude
          <input type="number" inputMode="decimal" min="-176" max="176" step="any" required value={longitude}
            onChange={event => setLongitude(event.target.value)} />
          <small>−176° to 176°</small>
        </label>
        <button className="pick-button" type="submit"><Crosshair size={16} aria-hidden="true" /> Rank custom region</button>
      </div>
    </form>
    <div className="earth-site-columns">
      {children}
      {previewSites.map(site => (
      <details className="earth-site earth-site-preview" key={site.id}>
        <summary>
          <span><strong>{site.name}</strong><small>{site.location} · Terrain ready to fetch</small></span>
        </summary>
        <div className="earth-site-detail"><p>{site.description}</p>
          <div className="analysis-actions">
            <button className="pick-button" type="button"
              onClick={() => void search(site.id)}>Fetch terrain</button>
            <a href={site.sourceUrl} target="_blank" rel="noreferrer">NASA source</a>
          </div>
        </div>
      </details>
      ))}
    </div>
  </div>;
}

function RankingBreakdown({ result }: { result: Analysis }) {
  const ranked = result.candidates.filter(candidate => candidate.rank !== undefined).slice(0, 10);
  const active = rankedFeatures.filter(([key]) => (result.effectiveWeights[key] ?? 0) > 0);
  const excluded = rankedFeatures.filter(([key]) => !result.effectiveWeights[key]);
  if (!ranked.length) return null;

  return <section className="profile ranking-breakdown" aria-labelledby="ranking-title">
    <div className="profile-heading"><h3 id="ranking-title">Top Earth matches</h3><span>{presets[result.preset]}</span></div>
    <Takeaway>The overall score combines the categories below. Higher means a closer modeled match for this mission.</Takeaway>
    <p className="chart-caption">Rank 1 is the closest match in this set. A 40% weight means that category can contribute up to 40 of 100 overall points. The smaller bars show the similarity within each category.</p>
    <ul className="science-legend">{active.map(([key, label, color]) =>
      <li key={key}><i style={{ background: color }} />{label} · {percent(result.effectiveWeights[key]!)}</li>)}</ul>
    {ranked.map(candidate => {
      const scores = rankingFeatureScores(result, candidate);
      return <div className="ranking-row" key={candidate.id}>
        <div className="lighting-track-heading"><strong>{candidate.rank}. {candidate.name}</strong><span>{percent(candidate.score!)}</span></div>
        <div className="ranking-bar" aria-hidden="true">{active.map(([key, , color]) =>
          <span key={key} style={{ background: color, width: percent((scores[key] ?? 0) * result.effectiveWeights[key]!) }} />)}</div>
        <ul className="ranking-points">{active.map(([key, label, color, purpose]) => <li key={key}>
          <span>{label} <strong>{percent(scores[key] ?? 0)}</strong></span>
          <small>{purpose}</small><progress value={scores[key] ?? 0} max={1} aria-label={label} style={{ accentColor: color }} />
        </li>)}</ul>
      </div>;
    })}
    {excluded.length > 0 && <p className="chart-caption">The ranking excludes {excluded.map(([, label]) => label.toLowerCase()).join(' and ')} because some evaluated routes lack comparable measurements.</p>}
  </section>;
}

export default function EarthComparison({ result, replayCase, onHighlight, onMoonOverlay, onUpdate, ranking, onRankingChange, mapOverlayControls, overlayMode }: {
  result: Analysis;
  replayCase: Replay | null;
  mapOverlayControls: (hasShadows: boolean, hasRocks: boolean) => ReactNode;
  overlayMode: 'lighting' | 'minerals' | null;
  ranking: boolean;
  onRankingChange: (ranking: boolean) => void;
  onUpdate: (analysis: Analysis) => void;
  onMoonOverlay: (overlay: RouteOverlay[]) => void;
  onHighlight: (point: Point | null) => void;
}) {
  const [earthOverlay, setEarthOverlay] = useState<RouteOverlay[]>([]);
  const [moonOverlay, setMoonOverlay] = useState<RouteOverlay[]>([]);
  const [terrainOverlay, setTerrainOverlay] = useState<TerrainMapOverlays | null>(null);
  const [roughnessThreshold, setRoughnessThreshold] = useState('');
  const [siteId, setSite] = useState<string | null>(result.fetchedSite ?? result.candidates.find(c => c.relief)?.id ?? result.candidates.find(c => c.status === 'matched')?.id ?? null);
  const [highlight, setHighlight] = useState<Point | null>(null);
  const site = result.candidates.find(c => c.id === siteId) ?? null;
  const reportHref = reportUrl(result, siteId, replayCase);
  const visibleSources = new Set([...result.lunar.evidence.sourceIds, ...(site?.evidence.sourceIds ?? [])]);
  const activeMoonOverlay = terrainOverlay?.moon ?? moonOverlay;

  useEffect(() => { onMoonOverlay(activeMoonOverlay); }, [onMoonOverlay, activeMoonOverlay]);
  useEffect(() => () => onMoonOverlay([]), [onMoonOverlay]);

  return (
    <>
    <section className="analysis-section earth-comparison" aria-labelledby="earth-title">
      <header className="panel-heading earth-heading">
        <h2 id="earth-title"><span className="planner-icon"><Globe2 size={19} /></span> Earth analog routes</h2>
        {!ranking && <div className="analysis-actions">
          <button className="pick-button" type="button" aria-pressed={!site} onClick={() => { setSite(null); setHighlight(null); onHighlight(null); }}>
            <Globe2 size={14} /> World view
          </button>
          <a className="pick-button export-action" href={reportHref} download>
            <Download size={14} /> Download report
          </a>
        </div>}
      </header>
      {!ranking && <>
        <Takeaway>{result.candidates[0]?.rank === 1 ? `${result.candidates[0].name} is the closest match in the current comparison for this mission objective.`
          : 'Earth sites receive a rank once enough terrain evidence is available to compare their routes.'}</Takeaway>
        <p className="mission-reading-guide">Choose a ranked site below the map to see its computed practice route. Ranks read down each column, from left to right. A and B mark the route endpoints. The shaded map shows ground shape around the site.</p>
        <section className="earth-ranking-weights" aria-labelledby="earth-weight-title">
          <div className="earth-ranking-objective">
            <p>Mission objective</p>
            <h3 id="earth-weight-title">{presets[result.preset]}</h3>
            <p>How much each factor counts toward the overall match.</p>
          </div>
          <dl className="earth-weight-values">
            {rankedFeatures.filter(([key]) => (result.effectiveWeights[key] ?? 0) > 0).map(([key, label, color]) => (
              <div className="earth-weight-value" key={key} style={{ borderTopColor: color }}>
                <dt>{label}</dt>
                <dd style={{ color }}>{percent(result.effectiveWeights[key]!)}</dd>
              </div>
            ))}
          </dl>
        </section>
      </>}
      <div className="earth-grid">
        {!ranking && <EarthMap candidates={result.candidates} site={site} onSelect={setSite} highlight={highlight} overlay={terrainOverlay?.earth ?? earthOverlay} satellite={customImageryUrl(result, site?.id)}
          overlayControls={site?.route ? mapOverlayControls(
            Boolean(site.lighting && (site.lighting.windows.length > 0 || site.lighting.closestFrame)),
            Boolean(site.minerals?.lithology?.segments.length)) : undefined} />}
        <EarthSiteList result={result} onUpdate={onUpdate} onRankingChange={onRankingChange}>
          {result.candidates.map(candidate => (
            <div key={candidate.id} className="earth-site" data-active={siteId === candidate.id}>
              <button type="button" aria-pressed={siteId === candidate.id} onClick={() => {
                setSite(candidate.id);
                setHighlight(null);
                onHighlight(null);
              }}>
                <span><strong>{candidate.rank ? `${candidate.rank}. ` : ''}{candidate.name}</strong>
                  <small>{candidate.location}</small>
                  <span className="earth-match-score">{candidate.score === undefined ? 'No score yet' : <><b>{percent(candidate.score)}</b> overall match</>}</span>
                </span>
                <ArrowUpRight size={17} />
              </button>
            </div>
          ))}
        </EarthSiteList>
      </div>
      {!ranking && <>
        <WhyThisSite result={result} site={site} reportHref={reportHref} />
        <EvidenceQuality result={result} site={site} />
        {site?.route ? <Fragment key={site.id}>
          <TerrainComparison lunar={result.lunar} earth={site.route} site={site} onOverlay={setTerrainOverlay}
            thresholdInput={roughnessThreshold} onThresholdChange={setRoughnessThreshold} />
          <ComparisonProfile lunar={result.lunar} earth={site.route} name={site.name}
            onHighlight={onHighlight} onEarthHighlight={setHighlight} />
        </Fragment> : site && <section className="profile earth-route-stats" aria-labelledby="earth-stats-title">
          <h3 id="earth-stats-title">{site.name} terrain comparison</h3>
          <p className="chart-caption">{site.description}</p>
          <p className="chart-caption">{site.reason ?? 'The app needs a usable comparison route before it can assign a score.'}</p>
        </section>}
        <RankingBreakdown result={result} />
        <RankingStability result={result} />
        <details className="evidence-list">
          <summary>Sources and limitations</summary>
          <p>Terrain measured on a 90 m grid. The ranking uses the features with comparable evidence across eligible sites.</p>
          <ul>{result.sources.filter(source => visibleSources.has(source.id)).map(source => (
            <li key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.id}</a> · {source.version} · {source.kind}</li>
          ))}</ul>
          <ul>{result.limitations.map(item => <li key={item}>{item}</li>)}</ul>
        </details>
      </>}
    </section>
      {!ranking && <RouteScience mode={overlayMode} onMinerals={onUpdate} result={result} site={site} onMoonOverlay={setMoonOverlay} onEarthOverlay={setEarthOverlay} onMoonHighlight={onHighlight} onEarthHighlight={setHighlight} />}
    </>
  );
}
