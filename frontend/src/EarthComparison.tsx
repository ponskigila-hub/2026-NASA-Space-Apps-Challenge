import L from 'leaflet';
import { ArrowUpRight, Crosshair, Download, Globe2, MapPin, Minus, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { presets, reportUrl, type Analysis, type Candidate, type Replay, type RouteOverlay, type TerrainRoute } from './analysisApi';
import RouteScience from './RouteScience';
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

function EarthMap({ candidates, site, onSelect, highlight, overlay }: {
  candidates: Candidate[];
  site: Candidate | null;
  onSelect: (id: string) => void;
  highlight: Point | null;
  overlay: RouteOverlay[];
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layers = useRef<L.LayerGroup | null>(null);
  const scienceLayer = useRef<L.LayerGroup | null>(null);
  const marker = useRef<L.CircleMarker | null>(null);
  const [imageFailed, setImageFailed] = useState(false);

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
    setImageFailed(false);
    group.clearLayers();
    if (site) {
      const [west, south, east, north] = site.bounds;
      L.imageOverlay(`${base}terrain/${site.id}-relief.webp`, [[south, west], [north, east]], { alt: '', pane: 'earthImagery' })
        .addTo(group);
      if (imagery) {
        const [west, south, east, north] = imagery.bounds;
        L.imageOverlay(`${base}earth/${site.id}.webp`, [[south, west], [north, east]], { alt: '', pane: 'earthImagery' })
          .on('error', () => setImageFailed(true)).addTo(group);
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
  }, [site, imagery, candidates, onSelect]);

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
        <h3><Globe2 size={17} aria-hidden="true" /> {site?.name ?? 'Earth overview'}</h3>
        <span className="map-source">{site ? imagery && !imageFailed ? 'Satellite imagery and terrain relief' : 'Terrain relief' : 'Analog sites'}</span>
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
      </div>
      <footer className="map-footer">
        <span className="map-position"><MapPin size={13} /> {site?.location ?? '3 volcanic fields'}</span>
        <span className="map-credit">
          {imagery && !imageFailed ? <a href={imagery.imagery[0]} target="_blank" rel="noreferrer">Modified Copernicus Sentinel data 2024</a>
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
  const [label, unit] = metrics[metric];
  const series = useMemo(() => {
    const distances = new Set([...lunar.profile, ...earth.profile].map(sample => sample.distanceKm));
    return Array.from(distances).sort((a, b) => a - b).map(km => ({
      km, moon: interpolate(lunar.profile, km, metric), earth: interpolate(earth.profile, km, metric),
    }));
  }, [lunar, earth, metric]);
  const precision = Math.max(lunar.lengthKm, earth.lengthKm) < 2 ? 2 : 1;
  return (
    <div className="profile earth-profile">
      <div className="profile-heading">
        <h3>Terrain comparison</h3>
        <div className="segmented" role="group" aria-label="Earth comparison metric">
          {(Object.keys(metrics) as Metric[]).map(key => <button key={key} type="button" aria-pressed={metric === key}
            onClick={() => setMetric(key)}>{key === 'elevationM' ? 'Elevation' : metrics[key][0]}</button>)}
        </div>
      </div>
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
            <Line name="Hadley" dataKey="moon" stroke="var(--muted)" strokeDasharray="5 4" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line name={name} dataKey="earth" stroke="var(--accent)" strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="chart-caption">{label} ({unit}) by distance along route (km)</p>
    </div>
  );
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

const rankedFeatures = [
  ['slope', 'Slope', '#e1f78e'],
  ['roughness', 'Roughness', '#93b257'],
  ['lighting', 'Lighting', '#a899ff'],
  ['mineral', 'Minerals', '#64ddd1'],
] as const;

function RankingBreakdown({ result }: { result: Analysis }) {
  const ranked = result.candidates.filter(candidate => candidate.rank !== undefined);
  const bands = result.rankings?.[result.preset]?.sharedBands ?? [];
  const active = rankedFeatures.filter(([key]) => (result.effectiveWeights[key] ?? 0) > 0);
  if (!ranked.length) return null;

  return <section className="profile ranking-breakdown" aria-labelledby="ranking-title">
    <div className="lighting-panel-heading"><h3 id="ranking-title">What drives the ranking</h3><span>{presets[result.preset]}</span></div>
    <ul className="science-legend">{active.map(([key, label, color]) =>
      <li key={key}><i style={{ background: color }} />{label} · {percent(result.effectiveWeights[key]!)}</li>)}</ul>
    {ranked.map(candidate => {
      const bandScores = candidate.minerals?.bandScores;
      const scores = { ...candidate.featureScores, lighting: candidate.lighting?.score,
        mineral: bands.length && bandScores ? bands.reduce((sum, band) => sum + bandScores[band], 0) / bands.length : undefined };
      return <div className="ranking-row" key={candidate.id}>
        <div className="lighting-track-heading"><strong>{candidate.rank}. {candidate.name}</strong><span>{percent(candidate.score!)}</span></div>
        <div className="ranking-bar" aria-hidden="true">{active.map(([key, , color]) =>
          <span key={key} style={{ background: color, width: percent((scores[key] ?? 0) * result.effectiveWeights[key]!) }} />)}</div>
        <ul className="ranking-points">{active.map(([key, label]) => <li key={key}>
          {label} <strong>{((scores[key] ?? 0) * result.effectiveWeights[key]! * 100).toFixed(1)} pts</strong>
        </li>)}</ul>
      </div>;
    })}
    {rankedFeatures.some(([key]) => !result.effectiveWeights[key]) && <p className="chart-caption">
      {rankedFeatures.filter(([key]) => !result.effectiveWeights[key]).map(([, label]) => label).join(' and ')} excluded from ranking until comparable evidence is available across eligible sites.</p>}
  </section>;
}

export default function EarthComparison({ result, replayCase, onHighlight, onMoonOverlay, onMinerals }: {
  result: Analysis;
  replayCase: Replay | null;
  onMinerals: (analysis: Analysis) => void;
  onMoonOverlay: (overlay: RouteOverlay[]) => void;
  onHighlight: (point: Point | null) => void;
}) {
  const [earthOverlay, setEarthOverlay] = useState<RouteOverlay[]>([]);
  const [siteId, setSite] = useState<string | null>(result.fetchedSite ?? result.candidates.find(c => c.status === 'matched')?.id ?? null);
  const [highlight, setHighlight] = useState<Point | null>(null);
  const site = result.candidates.find(c => c.id === siteId) ?? null;
  const visibleSources = new Set([...result.lunar.evidence.sourceIds, ...(site?.evidence.sourceIds ?? [])]);

  return (
    <>
    <section className="analysis-section earth-comparison" aria-labelledby="earth-title">
      <header className="panel-heading earth-heading">
        <h2 id="earth-title"><span className="planner-icon"><Globe2 size={19} /></span> Earth analog routes</h2>
        <div className="analysis-actions">
          <button className="pick-button" type="button" aria-pressed={!site} onClick={() => { setSite(null); setHighlight(null); onHighlight(null); }}>
            <Globe2 size={14} /> World view
          </button>
          <a className="pick-button" href={reportUrl(result, siteId, replayCase)} download>
            <Download size={14} /> Download report
          </a>
        </div>
      </header>
      <p className="earth-intro">{presets[result.preset]} · {Object.entries(result.effectiveWeights).map(([key, weight]) => `${percent(weight)} ${key}`).join(' · ')}</p>
      <div className="earth-grid">
        <EarthMap candidates={result.candidates} site={site} onSelect={setSite} highlight={highlight} overlay={earthOverlay} />
        <div className="earth-sites" aria-label="Earth analog sites" role="group">
          {result.candidates.map(candidate => (
            <div key={candidate.id} className="earth-site" data-active={siteId === candidate.id}>
              <button type="button" aria-pressed={siteId === candidate.id} onClick={() => {
                setSite(candidate.id);
                setHighlight(null);
                onHighlight(null);
              }}>
                <span><strong>{candidate.rank ? `${candidate.rank}. ` : ''}{candidate.name}</strong>
                  <small>{candidate.location} · {candidate.score === undefined ? 'Unevaluable' : percent(candidate.score)}</small></span>
                <ArrowUpRight size={17} />
              </button>
              {siteId === candidate.id && (
                <div className="earth-site-detail">
                  <p>{candidate.description}</p>
                  {candidate.route && candidate.featureScores ? (
                    <>
                      <div className="metric-grid grid-flow-dense">
                        <div><span>Length</span><strong>{candidate.route.lengthKm.toFixed(2)} <small>km</small></strong></div>
                        <div><span>Maximum grade</span><strong>{candidate.route.steepestDeg.toFixed(1)}<small>°</small></strong></div>
                        <div><span>Slope match</span><strong>{percent(candidate.featureScores.slope)}</strong></div>
                        <div><span>Roughness match</span><strong>{percent(candidate.featureScores.roughness)}</strong></div>
                        <div><span>Ascent</span><strong>{Math.round(candidate.route.ascentM).toLocaleString()} <small>m</small></strong></div>
                        <div><span>Descent</span><strong>{Math.round(candidate.route.descentM).toLocaleString()} <small>m</small></strong></div>
                      </div>
                      <p>{percent(candidate.route.corridor.coverage)} valid corridor · {candidate.evidence.confidence} coverage confidence</p>
                    </>
                  ) : <p>{candidate.reason}</p>}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      {site?.route && <ComparisonProfile key={site.id} lunar={result.lunar} earth={site.route} name={site.name}
        onHighlight={onHighlight} onEarthHighlight={setHighlight} />}
      <RankingBreakdown result={result} />
      <details className="evidence-list">
        <summary>Sources and limitations</summary>
        <p>Terrain measured on a 90 m grid. The ranking uses the features with comparable evidence across eligible sites.</p>
        <ul>{result.sources.filter(source => visibleSources.has(source.id)).map(source => (
          <li key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.id}</a> · {source.version} · {source.kind}</li>
        ))}</ul>
        <ul>{result.limitations.map(item => <li key={item}>{item}</li>)}</ul>
      </details>
    </section>
      <RouteScience onMinerals={onMinerals} result={result} site={site} onMoonOverlay={onMoonOverlay} onEarthOverlay={setEarthOverlay} onMoonHighlight={onHighlight} onEarthHighlight={setHighlight} />
    </>
  );
}
