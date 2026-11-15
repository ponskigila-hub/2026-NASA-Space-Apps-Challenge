import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { Clock3, Download, Sun } from 'lucide-react';
import type { Analysis, EarthLight, LightFrame, Candidate, RouteOverlay, TerrainRoute } from './analysisApi';
import TerrainRouteInset from './TerrainRouteInset';
import { lightingGaps, lightingTargets, meetsLightingTargets, observationCsv, shadowSegments, shadowStatistics,
  shadowStyle, travelSunShares, usableShadowShare, type ObservationWindow } from './lightingSimulation';
import { mapOverlay, pointAt, type Segment } from './routeOverlay';

const pct = (value?: number) => value === undefined ? '—' : `${(value * 100).toFixed(1)}%`;
const degrees = (value?: number) => value === undefined ? '—' : `${value.toFixed(1)}°`;
const points = (value?: number) => value === undefined ? '—' : `${(value * 100).toFixed(1)} pp`;
const km = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });
const localDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const date = (iso: string) => localDate.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));
const time = (iso: string) => iso.slice(11, 16);
const utc = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

function ShadowLegend() {
  return <ul className="science-legend lighting-map-legend">{[shadowStyle[0], shadowStyle[1], shadowStyle[-1]].map(style =>
    <li key={style.label}><i data-state={style.label} style={{ backgroundColor: style.color }} />{style.label}</li>)}</ul>;
}

function ShadowTimeline({ moon, earth, site, moonLength, limit, inspect }: {
  moon: Segment[];
  earth: Segment[];
  site: Candidate | null;
  moonLength: number;
  limit: number;
  inspect: (km: number | null) => void;
}) {
  const [cursor, setCursor] = useState(0);
  const distance = Math.min(cursor, limit);
  const tracks = [{ name: 'Hadley · Moon', segments: moon, length: moonLength },
    ...(site?.route ? [{ name: site.name, segments: earth, length: site.route.lengthKm }] : [])];
  return <div className="profile lighting-transect" data-lighting-panel>
    <h3>Shadow along the route</h3>
    <p>Follow each route from start to finish. Move the distance slider to locate that point on the maps.</p>
    <ShadowLegend />
    {tracks.map(({ name, segments, length }) => {
      const current = segments.find((segment, i) => distance >= segment.startKm
        && (distance < segment.endKm || (i === segments.length - 1 && distance <= segment.endKm)));
      return <div className="lighting-track-row" key={name}>
        <div className="lighting-track-heading"><strong>{name}</strong><span>
          {current?.label ?? (distance > (segments.at(-1)?.endKm ?? length) ? 'Beyond route' : 'Unavailable')}
        </span></div>
        <div className="science-track lighting-track" aria-hidden="true">
          {segments.map(segment => <span className="lighting-segment" key={segment.startKm} data-state={segment.label}
            title={`${segment.label} · ${km(segment.startKm)}–${km(segment.endKm)} km`}
            style={{ left: `${100 * segment.startKm / limit}%`, width: `${100 * (segment.endKm - segment.startKm) / limit}%`,
              backgroundColor: segment.color }} />)}
          {limit > 0 && <b className="lighting-cursor" style={{ left: `${100 * distance / limit}%` }} />}
        </div>
      </div>;
    })}
    <div className="science-axis" aria-hidden="true"><span>0 km</span><span>{km(limit / 2)} km</span><span>{km(limit)} km</span></div>
    {(moon.length > 0 || earth.length > 0) && <label className="sample-select lighting-distance">
      <span>Distance from start <output>{km(distance)} km</output></span>
      <input type="range" min={0} max={limit} step="any" value={distance} aria-label="Inspect distance" aria-valuetext={`${km(distance)} kilometers`}
        onFocus={() => inspect(distance)} onBlur={() => inspect(null)}
        onChange={event => { const value = Number(event.target.value); setCursor(value); inspect(value); }} />
    </label>}
  </div>;
}

function DirectionShares({ shares }: { shares: ReturnType<typeof travelSunShares> }) {
  if (!shares) return '—';
  return <dl className="lighting-direction-shares">{(['toward', 'across', 'away'] as const).map(direction => <div key={direction}>
    <dt>{direction}</dt><dd>{pct(shares[direction])}</dd>
  </div>)}</dl>;
}

function LightingMeasurements({ moon, earth, lunarRoute, site, moonSegments, earthSegments }: {
  moon: Analysis['lighting']; earth?: LightFrame; lunarRoute: TerrainRoute; site: Candidate | null;
  moonSegments: ReturnType<typeof shadowSegments>; earthSegments: ReturnType<typeof shadowSegments>;
}) {
  const gaps = lightingGaps(moon, earth);
  const lunar = shadowStatistics(moonSegments);
  const terrestrial = shadowStatistics(earthSegments);
  const lunarDirection = travelSunShares(lunarRoute, moon?.azimuthDeg, moon?.elevationDeg);
  const earthDirection = site?.route ? travelSunShares(site.route, earth?.azimuthDeg, earth?.elevationDeg) : undefined;
  const length = (value?: number) => value === undefined ? '—' : `${km(value)} km`;
  const rows: [string, string, ReactNode, ReactNode, string?][] = [
    ['Sun elevation', 'How high the Sun is above the horizon at the route midpoint.', degrees(moon?.elevationDeg), degrees(earth?.elevationDeg),
      gaps.elevationDeg === undefined ? undefined : degrees(gaps.elevationDeg)],
    ['Sun azimuth', 'Compass direction of the Sun. 0° is north and 90° is east.', degrees(moon?.azimuthDeg), degrees(earth?.azimuthDeg),
      gaps.azimuthDeg === undefined ? undefined : degrees(gaps.azimuthDeg)],
    ['Shadow coverage', 'Share of the route in shadow where the model could determine lighting.', pct(usableShadowShare(moon ?? undefined)), pct(usableShadowShare(earth)),
      gaps.shadowFraction === undefined ? undefined : points(gaps.shadowFraction)],
    ['Longest shadow stretch', 'Longest uninterrupted distance in modeled shadow.', length(lunar?.longestKm), length(terrestrial?.longestKm)],
    ['Sunlit-to-shadow transitions', 'Times the route enters known shadow directly from sunlight.', lunar?.transitions ?? '—', terrestrial?.transitions ?? '—'],
    ['Sun relative to travel', 'Share of the A-to-B route heading toward, across, or away from the Sun.',
      <DirectionShares shares={lunarDirection} />, <DirectionShares shares={earthDirection} />],
    ['Known coverage', 'Share of the full route where the model could determine sunlight or shadow.', pct(moon?.coverage), pct(earth?.coverage)],
  ];
  return <section className="profile lighting-measurements" data-lighting-panel aria-labelledby="lighting-measurements-title">
    <h3 id="lighting-measurements-title">Lighting measurements</h3>
    <p>Compare the current snapshots. The gaps show how far apart the values are. Shadow gaps are in percentage points (pp).</p>
    <table className="terrain-stats-table lighting-measurements-table" aria-labelledby="lighting-measurements-title">
      <thead><tr><th scope="col">Measurement</th><th scope="col">Moon <small>Hadley</small></th><th scope="col">Earth <small>{site?.name}</small></th></tr></thead>
      <tbody>{rows.map(([name, meaning, lunarValue, earthValue, gap]) => <tr key={name}>
        <th scope="row">{name}<span className="terrain-stat-meaning">{meaning}</span>
          {gap && <span className="lighting-stat-gap">Gap {gap}</span>}
        </th><td>{lunarValue}</td><td>{earthValue}</td>
      </tr>)}</tbody>
    </table>
  </section>;
}

function downloadWindow(site: Candidate, moon: Analysis['lighting'], window: ObservationWindow, frame: number) {
  const url = URL.createObjectURL(new Blob([observationCsv(site.name, moon, window, frame)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `astroscan-${site.id}-${window.startLocal.slice(0, 10)}-${time(window.startLocal).replace(':', '')}-lighting.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ObservationWindows({ site, moon, earth, selectedIndex, selectWindow, frameIndex }: {
  site: Candidate | null; moon: Analysis['lighting']; earth?: EarthLight | null;
  selectedIndex: number; selectWindow: (index: number) => void; frameIndex: number;
}) {
  const selected = earth?.windows[selectedIndex];
  return <section className="profile lighting-windows" data-lighting-panel aria-labelledby="observation-windows-title">
    <div className="profile-heading"><h3 id="observation-windows-title"><Clock3 size={17} aria-hidden="true" /> Earth observation windows</h3>
      {site && selected && <button className="pick-button export-action" type="button" onClick={() => downloadWindow(site, moon, selected, frameIndex)}>
        <Download size={15} aria-hidden="true" /> Export selected window (CSV)
      </button>}
    </div>
    <p>{moon?.earthStart && <>Search covered {moon.earthDays ?? 30} days starting {moon.earthStart} UTC. </>}
      A match needs daylight, at least {lightingTargets.coverage * 100}% known coverage, a Sun elevation gap of {lightingTargets.elevationDeg}° or less,
      and a shadow coverage gap of {lightingTargets.shadowFraction * 100} percentage points (pp) or less.</p>
    {selected && earth ? <>
      <p className="window-timezone"><strong>Site local time</strong> · {selected.timeZone}. Gaps use the best snapshot in each window.</p>
      <ol className="window-list lighting-observations" aria-label="Observation windows in chronological order">
        {earth.windows.map((item, index) => ({ item, index })).sort((a, b) => Date.parse(a.item.startUtc) - Date.parse(b.item.startUtc))
          .map(({ item, index }) => {
            const best = item.frames[item.bestFrame];
            const gaps = lightingGaps(moon, best);
            const meets = best && meetsLightingTargets(moon, best);
            const single = item.startUtc === item.endUtc;
            return <li key={item.startUtc}><button type="button" aria-pressed={index === selectedIndex} onClick={() => selectWindow(index)}>
              <strong>{date(item.startLocal)}{!single && item.startLocal.slice(0, 10) !== item.endLocal.slice(0, 10) && ` – ${date(item.endLocal)}`}</strong>
              <span className="lighting-window-time"><time dateTime={item.startUtc}>{time(item.startLocal)}</time>
                {!single && <>–<time dateTime={item.endUtc}>{time(item.endLocal)}</time></>}
              </span>
              <span className="lighting-window-gaps"><span>Sun elevation gap <b>{degrees(gaps.elevationDeg)}</b></span>
                <span>Shadow gap <b>{points(gaps.shadowFraction)}</b></span></span>
              <span className="lighting-window-status" data-match={Boolean(meets)}>{meets ? 'Meets both thresholds' : 'Outside lighting targets'}</span>
            </button></li>;
          })}
      </ol>
      <a className="lighting-preview-link" href="#lighting-snapshot-title">Go to selected shadow preview</a>
    </> : <p className="lighting-window-empty">{site?.route ? earth?.reason ?? 'No observation window is available for this route.'
      : 'Select an Earth site with a computed route to find comparable observation times.'}</p>}
  </section>;
}

function ObservationTime({ frame, selected, frameIndex, selectFrame }: {
  frame?: LightFrame; selected?: ObservationWindow; frameIndex: number; selectFrame: (index: number) => void;
}) {
  if (!frame) return null;
  const offset = frame.local.match(/([+-]\d\d:\d\d)$/)?.[1];
  const local = `${date(frame.local)} · ${time(frame.local)}`;
  const canScrub = Boolean(selected && selected.frames.length > 1);
  return <div className="lighting-observation-time">
    <div className="lighting-time-heading">
      {canScrub ? <label htmlFor="earth-observation-time">Earth observation time</label> : <strong>Earth observation time</strong>}
      <span>{selected ? selected.frames.length === 1 ? 'One modeled time' : `Snapshot ${frameIndex + 1} of ${selected.frames.length}` : 'Closest daylight · outside lighting targets'}</span>
    </div>
    <p><time dateTime={frame.utc}>{local}</time> <span>{selected?.timeZone ?? (offset ? `UTC${offset}` : 'local')} · {utc(frame.utc)}</span></p>
    {selected && canScrub && <>
      <input id="earth-observation-time" type="range" min={0} max={selected.frames.length - 1} step={1} value={frameIndex}
        aria-valuetext={`${local} local`} onChange={event => selectFrame(Number(event.target.value))} />
      <p className="chart-caption">Move through the available snapshots for this window to see how terrain shadows change.</p>
    </>}
  </div>;
}

function snapshotCaption(frame?: Partial<LightFrame> | null) {
  return <span className="lighting-map-sun">{frame?.elevationDeg === undefined ? 'Sun angle unavailable' : <>Sun elevation <strong>{degrees(frame.elevationDeg)}</strong></>}</span>;
}

function snapshotDescription(name: string, frame: Partial<LightFrame> | null | undefined, hasStates: boolean) {
  const share = usableShadowShare(frame ?? undefined);
  return hasStates && share !== undefined ? `${name} route. ${pct(share)} shadow among modeled terrain. ${pct(frame?.coverage)} known coverage.`
    : `${name} route. Shadow comparison unavailable.`;
}

export default function LightingSimulator({ result, site, active, onMoonOverlay, onEarthOverlay, inspect }: {
  result: Analysis; site: Candidate | null; active: boolean;
  onMoonOverlay: (overlay: RouteOverlay[]) => void; onEarthOverlay: (overlay: RouteOverlay[]) => void;
  inspect: (distance: number | null) => void;
}) {
  const section = useRef<HTMLElement>(null);
  useGSAP(() => {
    const media = gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.from('[data-lighting-panel]', { y: 10, opacity: .65, duration: .4, stagger: .07,
        ease: 'power2.out', clearProps: 'transform,opacity', scrollTrigger: { trigger: section.current, start: 'top 92%', once: true } });
    });
    return () => media.revert();
  }, { scope: section });

  const [selection, setSelection] = useState<{ window: number; frame: number | null }>({ window: 0, frame: null });
  const [cursor, setCursor] = useState<number | null>(null);
  const moon = result.lighting;
  const earth = site?.lighting;
  const selected = earth?.windows[selection.window];
  const frameIndex = selection.frame ?? selected?.bestFrame ?? 0;
  const frame = selected?.frames[frameIndex] ?? earth?.closestFrame ?? undefined;
  const earthRoute = site?.route;
  const moonSegments = useMemo(() => shadowSegments(result.lunar, moon?.sampleIndices, moon?.states), [result.lunar, moon]);
  const earthSegments = useMemo(() => earthRoute ? shadowSegments(earthRoute, earth?.sampleIndices, frame?.states) : [], [earthRoute, earth, frame]);
  const moonOverlay = useMemo(() => mapOverlay(result.lunar, moonSegments), [result.lunar, moonSegments]);
  const earthOverlay = useMemo(() => earthRoute ? mapOverlay(earthRoute, earthSegments) : [], [earthRoute, earthSegments]);

  useEffect(() => {
    if (!active) return;
    onMoonOverlay(moonOverlay);
    onEarthOverlay(earthOverlay);
    return () => { onMoonOverlay([]); onEarthOverlay([]); };
  }, [active, moonOverlay, earthOverlay, onMoonOverlay, onEarthOverlay]);

  return <section ref={section} className="analysis-section science-section lighting-section" aria-labelledby="lighting-title">
    <header className="panel-heading">
      <h2 id="lighting-title"><span className="planner-icon"><Sun size={19} aria-hidden="true" /></span> Lunar–Earth Lighting Simulator</h2>
    </header>
    <section className="profile lighting-simulator" data-lighting-panel aria-labelledby="lighting-snapshot-title">
      <h3 id="lighting-snapshot-title" tabIndex={-1}>Terrain shadow preview</h3>
      <p>The Moon stays at the selected lunar scenario. Choose an Earth observation window to compare which stretches are sunlit or in shadow.</p>
      {moon?.reason && <p className="analysis-note">{moon.reason}</p>}
      <ShadowLegend />
      <div className="lighting-preview-grid">
        <TerrainRouteInset name="Moon · Hadley" route={result.lunar} overlays={moonOverlay} pathColor={shadowStyle[-1].color}
          caption={<>{snapshotCaption(moon)}{moon?.utc && <time dateTime={moon.utc}>{utc(moon.utc)}</time>}</>}
          description={snapshotDescription('Hadley lunar', moon, moonSegments.length > 0)}
          marker={cursor !== null && cursor <= result.lunar.lengthKm ? pointAt(result.lunar, cursor) : null} />
        {site && earthRoute ? <TerrainRouteInset name={`Earth · ${site.name}`} route={earthRoute} site={site} overlays={earthOverlay}
          pathColor={shadowStyle[-1].color} caption={<>{snapshotCaption(frame)}{frame && <time dateTime={frame.utc}>{date(frame.local)} · {time(frame.local)} local</time>}</>}
          description={snapshotDescription(site.name, frame, earthSegments.length > 0)}
          marker={cursor !== null && cursor <= earthRoute.lengthKm ? pointAt(earthRoute, cursor) : null} />
          : <div className="lighting-preview-empty"><h4>Earth route</h4><p>Select an Earth site with a computed route to compare lighting.</p></div>}
      </div>
      <ObservationTime frame={frame} selected={selected} frameIndex={frameIndex} selectFrame={index => setSelection({ ...selection, frame: index })} />
    </section>
    <ObservationWindows site={site} moon={moon} earth={earth} selectedIndex={selection.window} frameIndex={frameIndex}
      selectWindow={index => setSelection({ window: index, frame: null })} />
    <ShadowTimeline moon={moonSegments} earth={earthSegments} site={site} moonLength={result.lunar.lengthKm} limit={Math.max(result.lunar.lengthKm, earthRoute?.lengthKm ?? 0)}
      inspect={distance => { setCursor(distance); inspect(distance); }} />
    <LightingMeasurements moon={moon} earth={frame} lunarRoute={result.lunar} site={site} moonSegments={moonSegments} earthSegments={earthSegments} />
    <div className="mission-callout lighting-limit"><strong>What this preview models</strong>
      <p>AstroScan models direct sunlight and terrain shadow along the route using a 90 m elevation grid. Atmosphere, clouds, surface reflectance, and camera settings also affect exposure, contrast, and visibility during field tests.</p>
    </div>
    <details className="evidence-list terrain-method"><summary>How AstroScan measures lighting</summary>
      {moon?.method && <p>{moon.method}</p>}
      <p>Sun direction uses the angle between each route step and the Sun at the route midpoint. Within 45° is toward the Sun, 135° or more is away, and angles in between are across. Unknown stretches break continuous shadows and transition counts.</p>
    </details>
  </section>;
}
