import { useEffect, useMemo, useState } from 'react';
import type { Candidate, TerrainRoute } from './analysisApi';
import type { LunarRegion } from './lunar';
import TerrainRouteInset from './TerrainRouteInset';
import { routeSections, terrainDistribution, terrainMetrics, terrainStatistics, type TerrainMapOverlays, type TerrainMetric } from './terrainDistribution';
const emptyOverlays = { moon: [], earth: [] };

function percent(value: number | null | undefined) {
  return value == null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function measurement(value: number | undefined, unit: string, precision = 1) {
  return Number.isFinite(value) ? `${value!.toLocaleString(undefined, {
    minimumFractionDigits: precision, maximumFractionDigits: precision,
  })}${unit}` : '—';
}

export default function TerrainComparison({ lunar, lunarRegion, earth, site, thresholdInput, onThresholdChange, onOverlay }: {
  lunar: TerrainRoute;
  lunarRegion?: LunarRegion;
  earth: TerrainRoute;
  site: Candidate;
  thresholdInput: string;
  onThresholdChange: (input: string) => void;
  onOverlay: (overlay: TerrainMapOverlays | null) => void;
}) {
  const moonName = lunarRegion?.shortName ?? 'Hadley';
  const moonSections = useMemo(() => routeSections(lunar), [lunar]);
  const earthSections = useMemo(() => routeSections(earth), [earth]);
  const [metric, setMetric] = useState<TerrainMetric>('slopeDeg');
  const [pinned, setPinned] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const inputNumber = Number(thresholdInput);
  const invalidThreshold = thresholdInput !== '' && (!Number.isFinite(inputNumber) || inputNumber < 0);
  const threshold = thresholdInput !== '' && !invalidThreshold ? inputNumber : undefined;
  const moonSlope = useMemo(() => terrainStatistics(moonSections, 'slopeDeg'), [moonSections]);
  const earthSlope = useMemo(() => terrainStatistics(earthSections, 'slopeDeg'), [earthSections]);
  const moonRough = useMemo(() => terrainStatistics(moonSections, 'roughnessM', threshold), [moonSections, threshold]);
  const earthRough = useMemo(() => terrainStatistics(earthSections, 'roughnessM', threshold), [earthSections, threshold]);
  const moonBins = useMemo(() => terrainDistribution(moonSections, metric), [moonSections, metric]);
  const earthBins = useMemo(() => terrainDistribution(earthSections, metric), [earthSections, metric]);
  const active = hovered ?? focused ?? pinned;
  const overlay = useMemo(() => active === null ? null : {
    moon: moonBins[active].overlays, earth: earthBins[active].overlays,
  }, [active, moonBins, earthBins]);
  useEffect(() => { onOverlay(overlay); }, [onOverlay, overlay]);
  useEffect(() => () => onOverlay(null), [onOverlay]);

  function clearRange() {
    setPinned(null);
    setHovered(null);
    setFocused(null);
  }

  const { label, unit, spokenUnit, boundaries } = terrainMetrics[metric];
  const suffix = unit === 'm' ? ' m' : '°';
  const longerRoute = Math.max(lunar.lengthKm, earth.lengthKm);
  const rows = [
    ['Average slope', 'Overall steepness of the ground along the route.', measurement(moonSlope?.mean, '°'), measurement(earthSlope?.mean, '°')],
    ['Median slope', 'At least half the sampled route is this steep or gentler.', measurement(moonSlope?.median, '°'), measurement(earthSlope?.median, '°')],
    ['90th-percentile slope', 'At least 90% of the sampled route is this steep or gentler.', measurement(moonSlope?.p90, '°'), measurement(earthSlope?.p90, '°')],
    ['Slope standard deviation', 'Higher values mean more variation in steepness.', measurement(moonSlope?.deviation, '°'), measurement(earthSlope?.deviation, '°')],
    ['Maximum route grade', 'Steepest uphill or downhill step along the path.', measurement(lunar.steepestDeg, '°'), measurement(earth.steepestDeg, '°')],
    ['Average roughness', 'Higher values mean more variation in nearby ground height.', measurement(moonRough?.mean, ' m'), measurement(earthRough?.mean, ' m')],
    ['Cumulative ascent', 'Total height gained across all uphill sections.', measurement(lunar.ascentM, ' m', 0), measurement(earth.ascentM, ' m', 0)],
    ['Cumulative descent', 'Total height lost across all downhill sections.', measurement(lunar.descentM, ' m', 0), measurement(earth.descentM, ' m', 0)],
    ['Corridor data coverage', `Share of terrain within ${lunar.corridor.halfWidthM} m of the route with usable data.`, percent(lunar.corridor.coverage), percent(earth.corridor.coverage)],
  ];
  const summary = [
    ['Lunar route length', measurement(lunar.lengthKm, ' km', 2), `Distance along the path at ${moonName}.`],
    ['Earth route length', measurement(earth.lengthKm, ' km', 2), `Distance along the path at ${site.name}.`],
    ['Length similarity', percent(longerRoute > 0 ? Math.min(lunar.lengthKm, earth.lengthKm) / longerRoute : null), 'Equal route lengths score 100%.'],
  ];

  return <section className="profile earth-route-stats terrain-comparison" aria-labelledby="earth-stats-title">
    <header className="terrain-comparison-heading">
      <h3 id="earth-stats-title">Terrain comparison</h3>
      <p className="chart-caption"><strong>{site.name}</strong> · {site.description}</p>
    </header>
    <dl className="terrain-summary">
      {summary.map(([name, value, description]) => <div key={name}>
        <dt>{name}</dt>
        <dd>{value}<small>{description}</small></dd>
      </div>)}
    </dl>
    <h4 id="terrain-measurements-title">Route measurements</h4>
    <table className="terrain-stats-table" aria-labelledby="terrain-measurements-title">
      <thead><tr><th scope="col">Measurement</th><th scope="col">Moon <small>{moonName}</small></th><th scope="col">Earth <small>{site.name}</small></th></tr></thead>
      <tbody>
        {rows.map(([name, meaning, moon, earth]) => <tr key={name}>
          <th scope="row">{name}<span className="terrain-stat-meaning">{meaning}</span></th>
          <td>{moon}</td><td>{earth}</td>
        </tr>)}
        <tr>
          <th scope="row">
            <label htmlFor="terrain-roughness-threshold">Route above roughness threshold</label>
            <span id="terrain-threshold-help" className="terrain-stat-meaning">Enter a roughness level to see how much of each route exceeds it.</span>
            <span className="terrain-threshold"><input id="terrain-roughness-threshold" type="number" inputMode="decimal" min="0" step="any" placeholder="Set threshold"
              aria-describedby={`terrain-threshold-unit terrain-threshold-help${invalidThreshold ? ' terrain-threshold-error' : ''}`} aria-invalid={invalidThreshold}
              value={thresholdInput} onChange={event => onThresholdChange(event.target.value)} />
              <span id="terrain-threshold-unit">m</span></span>
            {invalidThreshold && <small id="terrain-threshold-error">Enter a threshold of 0 m or more.</small>}
          </th>
          <td>{percent(moonRough?.above)}</td><td>{percent(earthRough?.above)}</td>
        </tr>
      </tbody>
    </table>

    <div className="terrain-distribution" onKeyDown={event => { if (event.key === 'Escape') clearRange(); }}>
      <div className="profile-heading">
        <h4 id="terrain-distribution-title">{label} distribution</h4>
        <div className="segmented" role="group" aria-label="Distribution metric">
          {(Object.keys(terrainMetrics) as TerrainMetric[]).map(key => <button key={key} type="button" aria-pressed={metric === key} onClick={() => {
            if (key !== metric) { clearRange(); setMetric(key); }
          }}>{terrainMetrics[key].label}</button>)}
        </div>
      </div>
      <div id="terrain-distribution-help" className="terrain-distribution-guide">
        <p>{metric === 'slopeDeg' ? 'See how much of each route crosses gentle or steep ground.' : 'See how much of each route crosses smooth or uneven ground.'} Each bar shows the share of sampled route length in that range.</p>
        <p>Select a range to keep its matching stretches highlighted on both maps. Hover or use keyboard focus to preview it.</p>
      </div>
      <div className="terrain-distribution-grid">
        <div className="terrain-histogram" role="group" aria-labelledby="terrain-distribution-title" aria-describedby="terrain-distribution-help">
          <div className="terrain-histogram-legend"><span data-body="moon">Moon</span><span data-body="earth">Earth</span></div>
          <div className="terrain-histogram-scale" aria-hidden="true"><span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div>
          <div onPointerLeave={() => setHovered(null)}>
            {boundaries.map((lower, index) => {
              const upper = boundaries[index + 1];
              const moon = moonBins[index].share;
              const earth = earthBins[index].share;
              const range = upper === undefined ? `${lower} ${spokenUnit} and above` : `${lower} to under ${upper} ${spokenUnit}`;
              return <button key={lower} className="terrain-bin" type="button" aria-pressed={pinned === index} data-active={active === index}
                aria-label={`${range}. Moon ${moon === null ? 'unavailable' : percent(moon)}. Earth ${earth === null ? 'unavailable' : percent(earth)}.`}
                onPointerEnter={event => { if (event.pointerType !== 'touch') setHovered(index); }} onPointerLeave={() => setHovered(null)}
                onFocus={event => { if (event.currentTarget.matches(':focus-visible')) setFocused(index); }} onBlur={() => setFocused(null)}
                onClick={() => setPinned(previous => previous === index ? null : index)}>
                <span className="terrain-bin-range">{upper === undefined ? `≥${lower}${suffix}` : `${lower}–${upper}${suffix}`}</span>
                <span className="terrain-bin-tracks" aria-hidden="true">
                  <span data-body="moon" style={{ width: `${(moon ?? 0) * 100}%` }} />
                  <span data-body="earth" style={{ width: `${(earth ?? 0) * 100}%` }} />
                </span>
                <span className="terrain-bin-values" aria-hidden="true"><span>{percent(moon)}</span><span>{percent(earth)}</span></span>
              </button>;
            })}
          </div>
          <p className="chart-caption terrain-bin-note">Each range includes its lower bound.</p>
        </div>
        <div className="terrain-insets">
          <div className="terrain-map-legend"><span>Full route</span><span>Matching stretches</span></div>
          <TerrainRouteInset name={`Moon · ${moonName}`} lunarRegion={lunarRegion} route={lunar} overlays={overlay?.moon ?? emptyOverlays.moon} />
          <TerrainRouteInset name={`Earth · ${site.name}`} route={earth} overlays={overlay?.earth ?? emptyOverlays.earth} site={site} />
          {pinned !== null && <button type="button" className="pick-button terrain-clear-range" onClick={clearRange}>Clear selected range</button>}
        </div>
      </div>
    </div>
    <details className="evidence-list terrain-method">
      <summary>How AstroScan measures terrain</summary>
      <p>Slope and roughness statistics weight each sample by the distance it represents along the route. Roughness measures local height variation in metres on a 90 m grid using a 450 m window.</p>
      <p>Length similarity divides the shorter route length by the longer one. Corridor coverage counts cells with both usable slope and roughness data.</p>
      {site.featureScores && <p>Corridor match scores describe how closely the terrain around the routes matches. For {site.name}, the slope match is {percent(site.featureScores.slope)} and the roughness match is {percent(site.featureScores.roughness)}.</p>}
    </details>
  </section>;
}
