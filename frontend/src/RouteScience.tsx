import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { Layers } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Analysis, Candidate, MineralEvidence, RouteOverlay, SpectralPoint } from './analysisApi';
import LightingSimulator from './LightingSimulator';
import { mapOverlay, pointAt, type Segment } from './routeOverlay';
import RouteStat from './RouteStat';
import { fetchMinerals } from './analysisApi';
import type { Point } from './lunar';

gsap.registerPlugin(useGSAP, ScrollTrigger);

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const colors = ['#f6bc67', '#64ddd1', '#b6a1fd', '#f582a3', '#aee075', '#fa936c', '#65aef5'];
const bandLabel: Record<string, string> = { oneMicron: 'Near 1 µm', twoMicron: 'Near 2 µm' };
function rockColor(rocks: NonNullable<MineralEvidence['lithology']>, name: string) {
  return colors[rocks.units.findIndex(unit => unit.name === name) % colors.length] ?? '#929a9d';
}

function rockSegments(evidence?: MineralEvidence | null): Segment[] {
  const rocks = evidence?.lithology;
  return rocks?.segments.map(({ unit, startKm, endKm }) => ({
    label: unit, color: rockColor(rocks, unit), startKm, endKm,
  })) ?? [];
}

function RouteStrip({ name, segments, limit, empty, children, cursor }: {
  name: string; segments: Segment[]; limit: number; empty?: string; children?: ReactNode; cursor?: number;
}) {
  const distance = (km: number) => km.toLocaleString(undefined, { maximumFractionDigits: km < 1 ? 3 : 1 });
  return <div className="science-route">
    <h3>{name}</h3>
    {children}
    {segments.length ? <>
      <div className="science-track" role="img" aria-label={`${name} by distance. ${segments.map(s =>
        `${s.label}, ${distance(s.startKm)} to ${distance(s.endKm)} km`).join('. ')}`}>
        {segments.map(segment => <span key={segment.startKm}
          title={`${segment.label} · ${distance(segment.startKm)}–${distance(segment.endKm)} km`}
          style={{ left: `${100 * segment.startKm / limit}%`, width: `${100 * (segment.endKm - segment.startKm) / limit}%`,
            background: segment.color }} />)}
        {cursor !== undefined && <b className="lighting-cursor" aria-hidden="true" style={{ left: `${100 * cursor / limit}%` }} />}
      </div>
      <div className="science-axis" aria-hidden="true"><span>0 km</span><span>{distance(limit / 2)} km</span><span>{distance(limit)} km</span></div>
    </> : <p>{empty ?? 'No data for this route.'}</p>}
  </div>;
}

const kmText = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });

function RockLegend({ evidence }: { evidence?: MineralEvidence | null }) {
  const rocks = evidence?.lithology;
  if (!rocks?.units.length) return null;
  return <ul className="science-legend">
    {rocks.units.map(unit => <li key={unit.name}><i style={{ background: rockColor(rocks, unit.name) }} />
      {unit.name} · {percent(unit.fraction)}</li>)}
    {rocks.coverage < 0.999 && <li><i style={{ background: '#929a9d' }} />Unmapped · {percent(1 - rocks.coverage)}</li>}
  </ul>;
}

const spectralBands = {
  oneMicron: { start: 850, end: 1050 },
  twoMicron: { start: 1800, end: 2250 },
};
type MineralBand = keyof typeof spectralBands;
const spectrumColors = { moon: 'var(--mission-lime)', earth: 'var(--mission-cyan)' };

function reflectanceAt(spectrum: SpectralPoint[], nm: number) {
  const index = spectrum.findIndex(point => point.nm >= nm);
  if (index < 0) return null;
  const point = spectrum[index];
  if (point.nm === nm) return point.median;
  const previous = spectrum[index - 1];
  if (!previous || previous.median === null || point.median === null || point.nm - previous.nm > 75) return null;
  return previous.median + (point.median - previous.median) * (nm - previous.nm) / (point.nm - previous.nm);
}

function supportSegments(evidence: MineralEvidence | null | undefined, band: MineralBand, length: number): Segment[] {
  const distances = evidence?.spectral.sampleDistancesKm;
  const flags = evidence?.spectral.bandSupport?.[band];
  if (!flags?.length || distances?.length !== flags.length) return [];
  const edges = [0, ...distances.slice(1).map((distance, index) => (distance + distances[index]) / 2), length];
  return flags.reduce<Segment[]>((segments, supported, index) => {
    const label = supported ? 'Band measured' : 'No usable band';
    const last = segments.at(-1);
    if (last?.label === label) last.endKm = edges[index + 1];
    else segments.push({ label, startKm: edges[index], endKm: edges[index + 1], color: supported ? '#e1f78e' : '#777d89' });
    return segments;
  }, []);
}

function BandStats({ name, body, evidence, band }: { name: string; body: 'moon' | 'earth'; evidence?: MineralEvidence | null; band: MineralBand }) {
  const summary = evidence?.spectral.bands?.[band];
  return <article className="mineral-stat-card" data-body={body}>
    <h4>{name}</h4>
    {summary ? <>
      <div className="mineral-depth"><strong>{percent(summary.coverage)}</strong>
        <span>Route samples with this signal</span></div>
      <div className="metric-grid mineral-stat-details">
        <RouteStat label="Band center" description="Typical wavelength where absorption was strongest.">
          {Math.round(summary.medianCenterNm)} <small>nm</small>
        </RouteStat>
        <RouteStat label="Absorption depth" description="Typical size of the dip below the estimated baseline.">
          {percent(summary.medianDepth)}
        </RouteStat>
        <RouteStat label="Distinct pixels" description="Number of separate satellite image pixels that detected the signal.">
          {summary.independentPixels}
        </RouteStat>
      </div>
    </> : <p className="mineral-empty">{evidence?.spectral.reason ?? 'No usable absorption band measured for this route.'}</p>}
  </article>;
}

function MineralComparison({ result, site, limit, inspect, onMinerals }: {
  result: Analysis; site: Candidate | null; limit: number;
  inspect: (km: number | null) => void;
  onMinerals: (analysis: Analysis) => void;
}) {
  const section = useRef<HTMLElement>(null);
  const [cursor, setCursor] = useState<number>();
  const distance = Math.min(cursor ?? 0, limit);
  const [fetchStatus, setFetchStatus] = useState('');
  const [fetching, setFetching] = useState(false);
  const fetchRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    setFetching(false);
    setFetchStatus('');
    return () => fetchRequest.current?.abort();
  }, [result.id, site?.id]);
  async function refreshMinerals() {
    if (!site?.route || fetching) return;
    const controller = new AbortController();
    fetchRequest.current = controller;
    setFetching(true);
    setFetchStatus(`Searching NASA for ${site.name}.`);
    try {
      const updated = await fetchMinerals(result, site.id, controller.signal, setFetchStatus);
      if (!controller.signal.aborted) onMinerals(updated);
    } catch (error) {
      if (!controller.signal.aborted) setFetchStatus(error instanceof Error ? error.message : 'Earthdata fetch failed.');
    } finally {
      if (!controller.signal.aborted) setFetching(false);
    }
  }
  const [band, setBand] = useState<MineralBand>('oneMicron');
  const moonName = result.lunarRegion?.shortName ?? 'Hadley';
  const moon = result.minerals;
  const earth = site?.minerals;
  const score = earth?.bandScores?.[band];
  const spectra = useMemo(() => {
    const moonPoints = moon?.spectral.spectrum ?? [];
    const earthPoints = earth?.spectral.spectrum ?? [];
    const wavelengths = [...new Set([...moonPoints, ...earthPoints].map(point => point.nm))].sort((a, b) => a - b);
    return wavelengths.map(nm => ({ nm, moon: reflectanceAt(moonPoints, nm), earth: reflectanceAt(earthPoints, nm) }));
  }, [moon, earth]);
  const hasMoon = spectra.some(sample => sample.moon !== null);
  const hasEarth = spectra.some(sample => sample.earth !== null);
  const moonSupport = supportSegments(moon, band, result.lunar.lengthKm);
  const earthSupport = site?.route ? supportSegments(earth, band, site.route.lengthKm) : [];
  useGSAP(() => {
    const motion = gsap.matchMedia();
    motion.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.from('[data-mineral-panel]', { y: 10, opacity: .65, duration: .4, stagger: .07,
        clearProps: 'transform,opacity', ease: 'power2.out',
        scrollTrigger: { trigger: section.current, start: 'top 92%', once: true } });
    });
    return () => motion.revert();
  }, { scope: section });

  return <section ref={section} className="analysis-section science-section lighting-section mineral-section" aria-labelledby="minerals-title">
    <header className="panel-heading">
      <h2 id="minerals-title"><span className="planner-icon"><Layers size={19} aria-hidden="true" /></span> Mineral evidence</h2>
    </header>
    <p className="mission-reading-guide">Choose a wavelength range to compare absorption signals. Similar signals can point to similar minerals.</p>
    <div className="mineral-controls">
      <p className="mineral-locations">
        <strong data-body="moon">{moonName}</strong>
        {site && <> · <strong data-body="earth">{site.name}</strong></>}
      </p>
      <div className="segmented" role="group" aria-label="Rock signal wavelength range">
        {(Object.keys(spectralBands) as MineralBand[]).map(key =>
          <button key={key} type="button" aria-pressed={band === key} onClick={() => setBand(key)}>{bandLabel[key]}</button>)}
      </div>
    </div>

    {site?.route && <div className="analysis-actions mineral-fetch">
      <button className="pick-button" type="button" disabled={fetching} onClick={() => void refreshMinerals()}>
        {fetching ? 'Fetching NASA measurements…' : 'Fetch mineral data'}
      </button>
      {fetchStatus && <p role="status">{fetchStatus}</p>}
    </div>}
    <div className="mineral-grid grid-flow-dense">
      <div className="profile" data-mineral-panel>
        <div className="profile-heading"><h3>Route reflectance</h3></div>
        {hasMoon || hasEarth ? <>
          <ul className="science-legend">
            {hasMoon && <li><i style={{ background: spectrumColors.moon }} />{moonName} · M³</li>}
            {hasEarth && <li><i style={{ background: spectrumColors.earth }} />{site?.name} · EMIT</li>}
            <li><i className="mineral-band-key" />Band search range</li>
          </ul>
          <div className="chart-container mineral-chart">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <LineChart data={spectra} margin={{ top: 10, right: 12, left: 0, bottom: 5 }} accessibilityLayer>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <ReferenceArea x1={spectralBands[band].start} x2={spectralBands[band].end} fill="var(--accent)" fillOpacity={.12} />
                <XAxis dataKey="nm" type="number" domain={[700, 2500]} tickCount={6} stroke="var(--muted)" tick={{ fontSize: 11 }} />
                <YAxis width={42} tickFormatter={value => `${Math.round(Number(value) * 100)}%`}
                  stroke="var(--muted)" tick={{ fontSize: 11 }} />
                <Tooltip contentStyle={{ background: 'var(--panel)', borderColor: 'var(--line)', borderRadius: 8 }}
                  labelFormatter={value => `${Number(value).toFixed(0)} nm`} formatter={value => percent(Number(value))} />
                {hasMoon && <Line dataKey="moon" name={moonName} stroke={spectrumColors.moon} strokeWidth={2} dot={false} isAnimationActive={false} />}
                {hasEarth && <Line dataKey="earth" name={site?.name} stroke={spectrumColors.earth} strokeWidth={2} dot={false} isAnimationActive={false} />}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="chart-caption">Reflectance (%) by wavelength (nm). Gaps mark insufficient data.</p>
        </> : <p className="mineral-empty">No calibrated spectra are available for these routes.</p>}
      </div>

      <div className="profile mineral-stats" data-mineral-panel>
        <div className="profile-heading"><h3>Rock signal coverage</h3><span>{bandLabel[band]}</span></div>
        <BandStats body="moon" name={`${moonName} · M³`} evidence={moon} band={band} />
        {site && <BandStats body="earth" name={`${site.name} · EMIT`} evidence={earth} band={band} />}
        {score !== undefined && <p className="mineral-match"><strong>{percent(score)}</strong> match in absorption depth and band center</p>}
      </div>
    </div>

    <div className="profile lighting-windows mineral-routes" data-mineral-panel>
      <div className="profile-heading"><h3>Evidence along the route</h3><span>Distance from start</span></div>
      <label className="sample-select lighting-distance">
        <span>Distance to inspect <output>{kmText(distance)} km</output></span>
        <input type="range" aria-label="Distance to inspect" min={0} max={limit} step="any" value={distance}
          aria-valuetext={`${kmText(distance)} kilometers`} onFocus={() => { setCursor(distance); inspect(distance); }}
          onBlur={() => { setCursor(undefined); inspect(null); }}
          onChange={event => { const km = Number(event.target.value); setCursor(km); inspect(km); }} />
      </label>
      {(moonSupport.length > 0 || earthSupport.length > 0) && <section className="mineral-route-group">
        <h4>Rock signal along the route</h4>
        <ul className="science-legend">
          <li><i style={{ background: '#e1f78e' }} />Band measured</li>
          <li><i style={{ background: '#777d89' }} />No usable band</li>
        </ul>
        <div className="mineral-route-site" data-body="moon">
          <RouteStrip name={moonName} segments={moonSupport} limit={limit} cursor={cursor === undefined ? undefined : distance}
            empty={`No band measurements for ${moonName}.`} />
        </div>
        {site?.route && <div className="mineral-route-site" data-body="earth">
          <RouteStrip name={site.name} segments={earthSupport} limit={limit} cursor={cursor === undefined ? undefined : distance}
            empty="No band measurements for this route." />
        </div>}
      </section>}
      <section className="mineral-route-group">
        <h4>Mapped rock types</h4>
        <div className="mineral-route-site" data-body="moon">
          <RouteStrip name={moonName} segments={rockSegments(moon)} limit={limit} cursor={cursor === undefined ? undefined : distance}
            empty={`No mapped geology for ${moonName}.`} />
          <RockLegend evidence={moon} />
        </div>
        {site?.route && <div className="mineral-route-site" data-body="earth">
          <RouteStrip name={site.name} segments={rockSegments(earth)} limit={limit} cursor={cursor === undefined ? undefined : distance}
            empty="No mapped geology for this route." />
          <RockLegend evidence={earth} />
        </div>}
      </section>
    </div>
    <details className="evidence-list">
      <summary>Sources and interpretation</summary>
      {[moon?.spectral, earth?.spectral].map((spectral, index) => spectral?.scene &&
        <p key={index}>{index === 0 ? 'Lunar M³' : 'Earth EMIT'} · <a href={spectral.url}>{spectral.scene}</a></p>)}
      <p>Band depth measures absorption within the selected wavelength range. Mapped rock units provide geologic context.</p>
      <p>Mineral ranking requires a shared band with at least 70% sample coverage and five distinct pixels across every eligible site.</p>
    </details>
  </section>;
}

export default function RouteScience({ result, site, onMoonOverlay, onEarthOverlay, onMoonHighlight, onEarthHighlight, onMinerals, mode }: {
  mode: 'lighting' | 'minerals' | null;
  result: Analysis;
  site: Candidate | null;
  onMoonOverlay: (overlay: RouteOverlay[]) => void;
  onEarthOverlay: (overlay: RouteOverlay[]) => void;
  onMoonHighlight: (point: Point | null) => void;
  onEarthHighlight: (point: Point | null) => void;
  onMinerals: (analysis: Analysis) => void;
}) {
  const moonRock = result.minerals;
  const earthRock = site?.minerals;
  const limit = Math.max(result.lunar.lengthKm, site?.route?.lengthKm ?? 0);

  useEffect(() => {
    if (mode !== 'minerals') return;
    onMoonOverlay(mapOverlay(result.lunar, rockSegments(moonRock)));
    onEarthOverlay(site?.route ? mapOverlay(site.route, rockSegments(earthRock)) : []);
    return () => { onMoonOverlay([]); onEarthOverlay([]); };
  }, [mode, result.lunar, moonRock, earthRock, site?.route, onMoonOverlay, onEarthOverlay]);

  function inspect(km: number | null) {
    onMoonHighlight(km !== null && km <= result.lunar.lengthKm ? pointAt(result.lunar, km) : null);
    onEarthHighlight(km !== null && site?.route && km <= site.route.lengthKm ? pointAt(site.route, km) : null);
  }

  return <>
    <LightingSimulator key={site?.id ?? 'overview'} result={result} site={site} active={mode === 'lighting'}
      inspect={inspect}
      onMoonOverlay={onMoonOverlay} onEarthOverlay={onEarthOverlay} />

    <MineralComparison onMinerals={onMinerals} inspect={inspect} result={result} site={site} limit={limit} />
  </>;
}
