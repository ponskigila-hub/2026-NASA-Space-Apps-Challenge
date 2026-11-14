import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { Clock3, Layers, Map, Sun } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Analysis, Candidate, EarthLight, MineralEvidence, RouteOverlay, SpectralPoint, TerrainRoute, ShadowState } from './analysisApi';

import { fetchMinerals } from './analysisApi';
import type { Point } from './lunar';

gsap.registerPlugin(useGSAP, ScrollTrigger);

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const colors = ['#f6bc67', '#64ddd1', '#b6a1fd', '#f582a3', '#aee075', '#fa936c', '#65aef5'];
const bandLabel: Record<string, string> = { oneMicron: 'Near 1 µm', twoMicron: 'Near 2 µm' };
const shadowStyle = {
  0: { label: 'Sunlit', color: '#ffd273' },
  1: { label: 'Shadow', color: '#a899ff' },
  '-1': { label: 'Unknown', color: '#929a9d' },
};

interface Segment {
  label: string;
  color: string;
  startKm: number;
  endKm: number;
}

function shadowSegments(route: TerrainRoute, indices?: number[], states?: ShadowState[]): Segment[] {
  if (!indices || !states || indices.length !== states.length) return [];
  const distances = indices.map(index => route.profile[index].distanceKm);
  const boundaries = [0, ...distances.slice(1).map((d, i) => (d + distances[i]) / 2), route.lengthKm];
  return states.reduce<Segment[]>((segments, state, index) => {
    const last = segments.at(-1);
    const style = shadowStyle[state];
    if (last?.label === style.label) last.endKm = boundaries[index + 1];
    else segments.push({ ...style, startKm: boundaries[index], endKm: boundaries[index + 1] });
    return segments;
  }, []);
}

function rockColor(rocks: NonNullable<MineralEvidence['lithology']>, name: string) {
  return colors[rocks.units.findIndex(unit => unit.name === name) % colors.length] ?? '#929a9d';
}

function rockSegments(evidence?: MineralEvidence | null): Segment[] {
  const rocks = evidence?.lithology;
  return rocks?.segments.map(({ unit, startKm, endKm }) => ({
    label: unit, color: rockColor(rocks, unit), startKm, endKm,
  })) ?? [];
}

function pointAt(route: TerrainRoute, km: number) {
  const index = route.profile.findIndex(sample => sample.distanceKm >= km);
  if (index <= 0) return index === 0 ? route.path[0] : route.path.at(-1)!;
  const { point: a, distanceKm: start } = route.profile[index - 1];
  const { point: b, distanceKm: end } = route.profile[index];
  const fraction = (km - start) / (end - start);
  return { lat: a.lat + (b.lat - a.lat) * fraction, lon: a.lon + (b.lon - a.lon) * fraction };
}

function mapOverlay(route: TerrainRoute, segments: Segment[]): RouteOverlay[] {
  return segments.map(({ color, startKm, endKm }) => ({
    color,
    points: [pointAt(route, startKm), ...route.profile.filter(sample =>
      sample.distanceKm > startKm && sample.distanceKm < endKm).map(sample => sample.point), pointAt(route, endKm)],
  }));
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

function ShadowTimeline({ moon, earth, site, limit, moonLength, earthLength, inspect }: {
  moon: Segment[]; earth: Segment[]; site?: string; limit: number; moonLength: number; earthLength?: number;
  inspect: (km: number | null) => void;
}) {
  const [cursor, setCursor] = useState(0);
  const distance = Math.min(cursor, limit);
  const tracks = [{ name: 'Hadley · Moon', segments: moon, length: moonLength },
    ...(site ? [{ name: site, segments: earth, length: earthLength }] : [])];
  return <div className="profile lighting-transect" data-lighting-panel>
    <div className="lighting-panel-heading"><h3>Shadow along the route</h3><span>Distance from start</span></div>
    <ul className="science-legend">{[shadowStyle[0], shadowStyle[1], shadowStyle[-1]].map(style =>
      <li key={style.label}><i data-state={style.label} style={{ backgroundColor: style.color }} />{style.label}</li>)}</ul>
    {tracks.map(({ name, segments, length }) => {
      const current = segments.find((segment, i) =>
        distance >= segment.startKm && (distance < segment.endKm || (i === segments.length - 1 && distance <= segment.endKm)));
      return <div className="lighting-track-row" key={name}>
        <div className="lighting-track-heading"><strong>{name}</strong><span>
          {current?.label ?? (length !== undefined && distance > length ? 'Beyond route' : 'Unavailable')}
        </span></div>
        <div className="science-track lighting-track" aria-hidden="true">
          {segments.map(segment => <span className="lighting-segment" key={segment.startKm} data-state={segment.label}
            title={`${segment.label} · ${kmText(segment.startKm)}–${kmText(segment.endKm)} km`}
            style={{ left: `${100 * segment.startKm / limit}%`, width: `${100 * (segment.endKm-segment.startKm) / limit}%`,
              backgroundColor: segment.color }} />)}
          <b className="lighting-cursor" style={{ left: `${100 * distance / limit}%` }} />
        </div>
      </div>;
    })}
    <div className="science-axis" aria-hidden="true"><span>0 km</span><span>{kmText(limit / 2)} km</span><span>{kmText(limit)} km</span></div>
    {(moon.length > 0 || earth.length > 0) && <label className="sample-select lighting-distance">
      <span>Inspect distance <output>{kmText(distance)} km</output></span>
      <input type="range" aria-label="Inspect distance" min={0} max={limit} step="any" value={distance} aria-valuetext={`${kmText(distance)} kilometers`}
        onFocus={() => inspect(distance)} onBlur={() => inspect(null)}
        onChange={event => { const km = Number(event.target.value); setCursor(km); inspect(km); }} />
    </label>}
  </div>;
}

function LightingMetrics({ moon, earth, site }: {
  moon: Analysis['lighting']; earth?: EarthLight['windows'][number]['frames'][number]; site?: string;
}) {
  const rows = [
    { label: 'In shadow', moon: moon?.shadowFraction, earth: earth?.shadowFraction, format: percent, share: true },
    { label: 'Sun elevation', moon: moon?.elevationDeg, earth: earth?.elevationDeg, format: (v: number) => `${v.toFixed(1)}°` },
    { label: 'Sun azimuth', moon: moon?.azimuthDeg, earth: earth?.azimuthDeg, format: (v: number) => `${v.toFixed(1)}°` },
    { label: 'Known coverage', moon: moon?.coverage, earth: earth?.coverage, format: percent },
  ];
  return <div className="profile lighting-metrics" data-lighting-panel>
    <div className="lighting-panel-heading"><h3>Moon–Earth comparison</h3>
      {moon?.shadowFraction !== undefined && earth && <span>{(Math.abs(earth.shadowFraction - moon.shadowFraction) * 100).toFixed(1)} pp shadow difference</span>}
    </div>
    <table>
      <thead><tr><th scope="col">Measure</th><th scope="col">Hadley</th><th scope="col">{site ?? 'Earth'}</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.label}><th scope="row">{row.label}</th>{[row.moon, row.earth].map((value, index) =>
        <td key={index}>{value === undefined ? <span className="lighting-missing" aria-label="Unavailable">—</span> : <>
          {row.format(value)}
          {row.share && <span className="lighting-share" aria-hidden="true"><i style={{ width: percent(value) }} /></span>}
        </>}</td>)}</tr>)}</tbody>
    </table>
    <p className="chart-caption">Shadow share uses known route samples. Azimuth is measured clockwise from north.</p>
  </div>;
}

function EarthControls({ earth, windowIndex, frameIndex, selectWindow, selectFrame, target }: {
  earth: EarthLight; windowIndex: number; frameIndex: number; target?: number;
  selectWindow: (index: number) => void; selectFrame: (index: number) => void;
}) {
  const window = earth.windows[windowIndex];
  const frame = window?.frames[frameIndex];
  if (!window || !frame) return null;
  const format = (value: string) => value.slice(0, 16).replace('T', ' ');
  return <>
    <p className="window-timezone">Local time · {window.timeZone}</p>
    <ol className="window-list" aria-label="Field-test windows in chronological order">
      {earth.windows.map((item, index) => ({ item, index })).sort((a, b) => Date.parse(a.item.startUtc) - Date.parse(b.item.startUtc))
        .map(({ item, index }) => {
          const best = item.frames[item.bestFrame];
          const minutes = (Date.parse(item.endUtc) - Date.parse(item.startUtc)) / 60_000;
          const end = item.startLocal.slice(0, 10) === item.endLocal.slice(0, 10) ? item.endLocal.slice(11, 16) : format(item.endLocal);
          return <li key={item.startUtc}>
            <button type="button" aria-pressed={index === windowIndex} onClick={() => selectWindow(index)}>
              <strong><time dateTime={item.startUtc}>{format(item.startLocal)}</time>{minutes > 0 && ` – ${end}`}</strong>
              <span>{minutes > 0 ? `${minutes} min sampled span` : 'Single qualifying sample'}</span>
              <span>{target !== undefined && `${(Math.abs(best.shadowFraction - target) * 100).toFixed(1)} pp shadow difference · `}
                {percent(best.coverage)} coverage</span>
            </button>
          </li>;
        })}
    </ol>
    <div className="science-controls">
      {window.frames.length > 1 && <label className="sample-select">Shadow frame · {frameIndex + 1} of {window.frames.length}
        <input type="range" min={0} max={window.frames.length - 1} value={frameIndex} onChange={event => selectFrame(Number(event.target.value))} />
      </label>}
    </div>
    <p>{format(frame.local)} local · {format(frame.utc)} UTC</p>
  </>;
}

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
const spectrumColors = { moon: 'var(--accent)', earth: '#64ddd1' };

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

function BandStats({ name, evidence, band }: { name: string; evidence?: MineralEvidence | null; band: MineralBand }) {
  const summary = evidence?.spectral.bands?.[band];
  return <article className="mineral-stat-card">
    <h4>{name}</h4>
    {summary ? <>
      <div className="mineral-depth"><strong>{percent(summary.medianDepth)}</strong><span>Median absorption depth</span></div>
      <dl className="mineral-stat-details">
        <div><dt>Band center</dt><dd>{Math.round(summary.medianCenterNm)} nm</dd></div>
        <div><dt>Samples with band</dt><dd>{percent(summary.coverage)}</dd></div>
        <div><dt>Distinct pixels</dt><dd>{summary.independentPixels}</dd></div>
      </dl>
    </> : <p className="mineral-empty">{evidence?.spectral.reason ?? 'No usable absorption band measured for this route.'}</p>}
  </article>;
}

function MineralComparison({ result, site, limit, active, onToggle, inspect, onMinerals }: {
  result: Analysis; site: Candidate | null; limit: number; active: boolean; onToggle: () => void;
  inspect: (km: number | null) => void;
  onMinerals: (analysis: Analysis) => void;
}) {
  const section = useRef<HTMLElement>(null);
  const [cursor, setCursor] = useState<number>();
  const distance = Math.min(cursor ?? 0, limit);
  const [fetchStatus, setFetchStatus] = useState('');
  const [fetching, setFetching] = useState(false);
  const fetchRequest = useRef<AbortController | null>(null);
  useEffect(() => () => fetchRequest.current?.abort(), []);
  async function refreshMinerals() {
    if (!site?.route) return;
    const controller = new AbortController();
    fetchRequest.current = controller;
    setFetching(true);
    setFetchStatus(`Searching NASA for ${site.name}.`);
    try {
      onMinerals(await fetchMinerals(result, site.id, controller.signal, setFetchStatus));
    } catch (error) {
      if (!controller.signal.aborted) setFetchStatus(error instanceof Error ? error.message : 'Earthdata fetch failed.');
    } finally {
      if (!controller.signal.aborted) setFetching(false);
    }
  }
  const [band, setBand] = useState<MineralBand>('oneMicron');
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

  return <section ref={section} className="analysis-section science-section lighting-section" aria-labelledby="minerals-title">
    <header className="panel-heading">
      <h2 id="minerals-title"><span className="planner-icon"><Layers size={19} aria-hidden="true" /></span> Mineral evidence</h2>
      <button className="pick-button lighting-map-button" type="button" aria-pressed={active}
        onClick={onToggle}><Map size={15} aria-hidden="true" /> Show rock units on maps</button>
    </header>
    <div className="mineral-controls">
      <p>{site ? `Hadley · ${site.name}` : 'Select an Earth site to compare with Hadley.'}</p>
      <div className="segmented" role="group" aria-label="Absorption band">
        {(Object.keys(spectralBands) as MineralBand[]).map(key =>
          <button key={key} type="button" aria-pressed={band === key} onClick={() => setBand(key)}>{bandLabel[key]}</button>)}
      </div>
    </div>

    {site?.route && <div className="analysis-actions">
      <button className="pick-button" type="button" disabled={fetching} onClick={() => void refreshMinerals()}>
        {fetching ? 'Fetching EMIT data…' : 'Fetch mineral data'}
      </button>
      {fetchStatus && <p role="status">{fetchStatus}</p>}
    </div>}
    <div className="lighting-grid mineral-grid grid-flow-dense">
      <div className="profile" data-mineral-panel>
        <div className="lighting-panel-heading"><h3>Route reflectance</h3><span>Median by wavelength</span></div>
        {hasMoon || hasEarth ? <>
          <ul className="science-legend">
            {hasMoon && <li><i style={{ background: spectrumColors.moon }} />Hadley · M³</li>}
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
                {hasMoon && <Line dataKey="moon" name="Hadley" stroke={spectrumColors.moon} strokeWidth={2} dot={false} isAnimationActive={false} />}
                {hasEarth && <Line dataKey="earth" name={site?.name} stroke={spectrumColors.earth} strokeWidth={2} dot={false} isAnimationActive={false} />}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="chart-caption">Reflectance (%) by wavelength (nm). Gaps indicate insufficient valid samples.</p>
        </> : <p className="mineral-empty">No calibrated spectra are available for these routes.</p>}
      </div>

      <div className="profile mineral-stats" data-mineral-panel>
        <div className="lighting-panel-heading"><h3>Absorption statistics</h3><span>{bandLabel[band]}</span></div>
        <BandStats name="Hadley · M³" evidence={moon} band={band} />
        {site && <BandStats name={`${site.name} · EMIT`} evidence={earth} band={band} />}
        {score !== undefined && <p className="mineral-match"><strong>{percent(score)}</strong> band similarity for this pair</p>}
      </div>
    </div>

    <div className="profile lighting-windows mineral-routes" data-mineral-panel>
      <div className="lighting-panel-heading"><h3>Evidence along the route</h3><span>Distance from start</span></div>
      <label className="sample-select lighting-distance">
        <span>Inspect mineral distance <output>{kmText(distance)} km</output></span>
        <input type="range" aria-label="Inspect mineral distance" min={0} max={limit} step="any" value={distance}
          aria-valuetext={`${kmText(distance)} kilometers`} onFocus={() => { setCursor(distance); inspect(distance); }}
          onBlur={() => { setCursor(undefined); inspect(null); }}
          onChange={event => { const km = Number(event.target.value); setCursor(km); inspect(km); }} />
      </label>
      {(moonSupport.length > 0 || earthSupport.length > 0) && <>
        <h4>{bandLabel[band]} · spectral coverage</h4>
        <ul className="science-legend">
          <li><i style={{ background: '#e1f78e' }} />Band measured</li>
          <li><i style={{ background: '#777d89' }} />No usable band</li>
        </ul>
        <RouteStrip name="Hadley" segments={moonSupport} limit={limit} cursor={cursor === undefined ? undefined : distance} empty="No band measurements for Hadley." />
        {site?.route && <RouteStrip name={site.name} segments={earthSupport} limit={limit} cursor={cursor === undefined ? undefined : distance}
          empty="No band measurements for this Earth route." />}
      </>}
      <h4>Mapped rock units</h4>
      <RouteStrip name="Hadley" segments={rockSegments(moon)} limit={limit} cursor={cursor === undefined ? undefined : distance} empty="No mapped geology for Hadley." />
      <RockLegend evidence={moon} />
      {site?.route && <>
        <RouteStrip name={site.name} segments={rockSegments(earth)} limit={limit} cursor={cursor === undefined ? undefined : distance} empty="No mapped geology for this route." />
        <RockLegend evidence={earth} />
      </>}
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

export default function RouteScience({ result, site, onMoonOverlay, onEarthOverlay, onMoonHighlight, onEarthHighlight, onMinerals }: {
  result: Analysis;
  site: Candidate | null;
  onMoonOverlay: (overlay: RouteOverlay[]) => void;
  onEarthOverlay: (overlay: RouteOverlay[]) => void;
  onMoonHighlight: (point: Point | null) => void;
  onEarthHighlight: (point: Point | null) => void;
  onMinerals: (analysis: Analysis) => void;
}) {
  const lightingSection = useRef<HTMLElement>(null);
  useGSAP(() => {
    const media = gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.from('[data-lighting-panel]', { y: 10, opacity: .65, duration: .4, stagger: .07,
        ease: 'power2.out', clearProps: 'transform,opacity',
        scrollTrigger: { trigger: lightingSection.current, start: 'top 92%', once: true } });
    });
    return () => media.revert();
  }, { scope: lightingSection });
  const [mode, setMode] = useState<'lighting' | 'minerals' | null>(null);
  const [selection, setSelection] = useState({ siteId: site?.id, window: 0, frame: site?.lighting?.windows[0]?.bestFrame ?? 0 });
  const moon = result.lighting;
  const earth = site?.lighting;
  const windowIndex = selection.siteId === site?.id ? selection.window : 0;
  const window = earth?.windows[windowIndex];
  const frameIndex = selection.siteId === site?.id ? selection.frame : window?.bestFrame ?? 0;
  const frame = window?.frames[frameIndex];
  const moonRock = result.minerals;
  const earthRock = site?.minerals;
  const limit = Math.max(result.lunar.lengthKm, site?.route?.lengthKm ?? 0);

  useEffect(() => {
    const lunarSegments = mode === 'lighting' ? shadowSegments(result.lunar, moon?.sampleIndices, moon?.states)
      : mode === 'minerals' ? rockSegments(moonRock) : [];
    const earthSegments = !site?.route ? [] : mode === 'lighting' ? shadowSegments(site.route, earth?.sampleIndices, frame?.states)
      : mode === 'minerals' ? rockSegments(earthRock) : [];
    onMoonOverlay(mapOverlay(result.lunar, lunarSegments));
    onEarthOverlay(site?.route ? mapOverlay(site.route, earthSegments) : []);
    return () => { onMoonOverlay([]); onEarthOverlay([]); };
  }, [mode, moon, earth, frame, result.lunar, moonRock, earthRock, site?.route, onMoonOverlay, onEarthOverlay]);

  function inspect(km: number | null) {
    onMoonHighlight(km !== null && km <= result.lunar.lengthKm ? pointAt(result.lunar, km) : null);
    onEarthHighlight(km !== null && site?.route && km <= site.route.lengthKm ? pointAt(site.route, km) : null);
  }

  return <>
    <section ref={lightingSection} className="analysis-section science-section lighting-section" aria-labelledby="lighting-title">
      <header className="panel-heading">
        <h2 id="lighting-title"><span className="planner-icon"><Sun size={19} aria-hidden="true" /></span> Lighting &amp; shadows</h2>
        <button className="pick-button lighting-map-button" type="button" aria-pressed={mode === 'lighting'}
          disabled={!moon?.states?.length && !frame?.states.length}
          onClick={() => setMode(mode === 'lighting' ? null : 'lighting')}><Map size={15} aria-hidden="true" /> Show shadows on maps</button>
      </header>
      {moon?.utc && <p className="lighting-scenario"><Clock3 size={15} aria-hidden="true" />
        Lunar scenario <time dateTime={moon.utc}>{moon.utc.slice(0, 16).replace('T', ' ')} UTC</time>
      </p>}
      {moon?.reason && <p className="analysis-note">{moon.reason}</p>}
      <div className="lighting-grid grid-flow-dense">
        <ShadowTimeline moon={shadowSegments(result.lunar, moon?.sampleIndices, moon?.states)}
          earth={site?.route ? shadowSegments(site.route, earth?.sampleIndices, frame?.states) : []}
          site={site?.route ? site.name : undefined} limit={limit} moonLength={result.lunar.lengthKm} earthLength={site?.route?.lengthKm} inspect={inspect} />
        <LightingMetrics moon={moon} earth={frame} site={site?.name} />
      </div>
      <div className="profile lighting-windows" data-lighting-panel>
        <div className="lighting-panel-heading"><h3><Clock3 size={15} aria-hidden="true" /> Earth field-test windows</h3>
          {moon?.earthStart && <span>{moon.earthDays ?? 30} days from {moon.earthStart} UTC</span>}
        </div>
        {earth && frame ? <EarthControls earth={earth} target={moon?.shadowFraction} windowIndex={windowIndex} frameIndex={frameIndex}
          selectWindow={index => setSelection({ siteId: site?.id, window: index, frame: earth.windows[index].bestFrame })}
          selectFrame={index => setSelection({ siteId: site?.id, window: windowIndex, frame: index })} />
          : <p>{site?.route ? earth?.reason ?? 'No comparable lighting window for this route.'
              : 'Select an Earth site with a computed route to compare shadows.'}</p>}
      </div>
      <details className="evidence-list"><summary>Lighting method</summary><p>{moon?.method}</p></details>
    </section>

    <MineralComparison onMinerals={onMinerals} inspect={inspect} result={result} site={site} limit={limit} active={mode === 'minerals'}
      onToggle={() => setMode(mode === 'minerals' ? null : 'minerals')} />
  </>;
}
