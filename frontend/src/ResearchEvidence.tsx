import { useMemo } from 'react';
import { Download } from 'lucide-react';
import { presets, type Analysis, type Candidate, type MineralEvidence } from './analysisApi';
import { rankedFeatures, rankingFeatureScores, testRankingStability } from './rankingEvidence';

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const points = (value: number) => (value * 100).toFixed(1);
const number = new Intl.NumberFormat();
const bands = [ ['oneMicron', 'Near 1 µm'], ['twoMicron', 'Near 2 µm'] ] as const;

const bestWindow = (site: Candidate | null) => site?.lighting?.windows[0];

function Coverage({ value, note }: { value?: number | null; note?: string }) {
  return <span className="research-coverage">
    <strong>{value == null ? '—' : percent(value)}</strong>{note && <small>{note}</small>}
  </span>;
}

function mineralCoverage(evidence: MineralEvidence | null | undefined, band: string) {
  const measured = evidence?.spectral.bands?.[band];
  return measured ? <Coverage value={measured.coverage} note={`${number.format(measured.independentPixels)} distinct pixels`} />
    : <Coverage note={evidence?.spectral.bands ? 'No usable samples' : 'Band data unavailable'} />;
}

function mineralUse(result: Analysis, site: Candidate) {
  const scoring = (result.effectiveWeights.mineral ?? 0) > 0;
  const comparable = Object.keys(site.minerals?.bandScores ?? {}).length > 0;
  const sampled = Object.values(site.minerals?.spectral.bands ?? {}).some(band => band.coverage > 0);
  if (scoring && comparable) return 'Mineral scoring uses bands with comparable measurements across all evaluated sites.';
  if (comparable) return 'This site has spectra comparable with the Moon. Mineral scoring requires a band shared by every evaluated site.';
  if (sampled) return 'Some spectra were measured here. A comparable Moon–Earth mineral score still needs more evidence.';
  return 'Calibrated Earth spectra are unavailable for this route. Mineral comparison requires additional measurements.';
}

export function EvidenceQuality({ result, site }: { result: Analysis; site: Candidate | null }) {
  const lunarTerrain = result.lunar.evidence.coverage ?? result.lunar.corridor.coverage;
  const earthTerrain = site?.evidence.coverage ?? site?.route?.corridor.coverage;
  const window = bestWindow(site);
  const earthLight = window?.frames[window.bestFrame] ?? site?.lighting?.closestFrame;
  const terrainResolution = result.lunar.evidence.analysisResolutionM;
  const activeLight = (result.effectiveWeights.lighting ?? 0) > 0;
  const shared = result.rankings?.[result.preset]?.sharedBands ?? [];
  const rankingMinerals = (result.effectiveWeights.mineral ?? 0) > 0;
  return <section className="profile research-panel" aria-labelledby="evidence-quality-title">
    <h3 id="evidence-quality-title" tabIndex={-1}>Evidence quality</h3>
    <p className="chart-caption">Coverage shows how much usable data supports each comparison.</p>
    <table className="terrain-stats-table research-evidence-table" aria-labelledby="evidence-quality-title">
      <thead><tr><th scope="col">Evidence</th><th scope="col">Moon <small>{result.lunarRegion?.shortName ?? 'Hadley'}</small></th><th scope="col">Earth <small>{site?.name}</small></th></tr></thead>
      <tbody>
        <tr><th scope="row">Terrain coverage<span className="terrain-stat-meaning">Corridor cells with usable slope and roughness data.</span></th>
          <td><Coverage value={lunarTerrain} /></td><td><Coverage value={earthTerrain} /></td></tr>
        <tr><th scope="row">Lighting model coverage<span className="terrain-stat-meaning">Route with a known sunlit or shadow state at this snapshot.</span></th>
          <td><Coverage value={result.lighting?.coverage} note={result.lighting?.coverage !== undefined ? 'Lunar time' : 'Unavailable'} /></td>
          <td><Coverage value={earthLight?.coverage} note={earthLight ? window ? 'Best window' : 'Closest daylight' : site ? 'Unavailable' : undefined} /></td></tr>
        {bands.map(([band, label]) => <tr key={band}>
          <th scope="row">Mineral coverage · {label}<span className="terrain-stat-meaning">Route samples with usable readings for this band.
            {rankingMinerals && shared.includes(band) && ' Used in mineral ranking.'}</span></th>
          <td>{mineralCoverage(result.minerals, band)}</td><td>{site ? mineralCoverage(site.minerals, band) : <Coverage />}</td>
        </tr>)}
      </tbody>
    </table>
    <div className="research-interpretation">
      <h4>Interpretation</h4>
      {site?.route ? <ul>
        {earthTerrain !== undefined && <li>{Math.min(lunarTerrain, earthTerrain) >= .95
          ? `Both corridors meet the 95% terrain coverage requirement for comparing broad slopes and roughness at ${terrainResolution} m resolution.`
          : 'Terrain coverage is limited. Inspect the available route data before drawing conclusions about the terrain match.'}</li>}
        <li>{mineralUse(result, site)} <a href="#minerals-title">Review mineral evidence</a>.</li>
        {activeLight ? <li>{window ? 'Lighting contributes to the ranking, and at least one daytime window meets both targets.'
          : 'Lighting contributes using the closest modeled daylight. No available window meets both lighting targets.'}</li>
          : <li>Lighting is excluded from the current ranking. It requires comparable model results across the evaluated sites.</li>}
      </ul> : <p>{site ? 'Earth evidence is available when the search finds an eligible route for this site.' : 'Select an Earth site with an evaluated route to compare data coverage.'}</p>}
    </div>
    <div className="research-limits">
      <h4>Model limitations</h4>
      <ul>
        <li>The <strong>{terrainResolution} m elevation grid</strong> resolves broad terrain. Individual rocks and small rover-scale hazards need finer data or field inspection.</li>
        <li>The Earth search shortlists <strong>up to ten windows</strong> and considers <strong>up to five endpoint pairs</strong> per window in each region. Rankings apply to the routes found in that search.</li>
        <li><strong>Soil traction, wheel slip, thermal conditions, and rover safety</strong> require separate field or engineering evaluation.</li>
      </ul>
    </div>
    <a className="research-jump" href="#ranking-stability-title">See how the ranking responds to weight changes</a>
  </section>;
}

function researchUse(result: Analysis, site: Candidate) {
  if (result.preset === 'camera_lighting') {
    return bestWindow(site) ? 'Preview a matching daylight window to plan camera tests across sunlit and shadowed stretches.'
      : 'Use the route for camera navigation practice. Assess daylight separately before a test that requires similar shadow conditions.';
  }
  if (result.preset === 'mineral_mapping') {
    if (Object.keys(site.minerals?.bandScores ?? {}).length) return 'Collect field spectra where the satellite measurements overlap and compare the sampled absorption bands.';
    return site.minerals?.lithology?.coverage ? 'Use mapped rock units to plan sampling. Collect calibrated field spectra to assess mineral similarity.'
      : 'Scout the route for representative sampling locations and collect field spectra for a mineral comparison.';
  }
  return 'Consider this route for navigation or route-following trials. Use the slope and roughness charts to choose stretches that reproduce the terrain conditions you want to test.';
}

export function WhyThisSite({ result, site, reportHref }: { result: Analysis; site: Candidate | null; reportHref: string }) {
  const route = site?.route;
  const evaluated = result.candidates.filter(candidate => candidate.rank !== undefined).length;
  const features = site ? rankingFeatureScores(result, site) : null;
  const reference = site?.rank === undefined ? undefined : result.candidates.find(candidate => candidate.rank === (site.rank === 1 ? 2 : 1));
  const referenceFeatures = reference && rankingFeatureScores(result, reference);
  const margin = site?.score !== undefined && reference?.score !== undefined ? site.score - reference.score : undefined;
  const contributions = rankedFeatures.flatMap(([key, label]) => {
    const weight = result.effectiveWeights[key];
    const value = features?.[key];
    const against = referenceFeatures?.[key];
    return weight && value !== undefined ? [{ label, value: weight * value, advantage: against === undefined ? 0 : weight * (value - against) }] : [];
  }).sort((a, b) => b.value - a.value);
  const top = contributions[0];
  const advantage = contributions.reduce<typeof top | undefined>((largest, item) =>
    item.advantage > (largest?.advantage ?? 0) ? item : largest, undefined);
  const windows = site?.lighting?.windows.length ?? 0;
  return <section className="profile research-panel why-site" aria-labelledby="analogy-title">
    <h3 id="analogy-title" tabIndex={-1}>{site ? `Why ${site.name}?` : 'Why this site?'}</h3>
    {site && route ? <>
      <div className="research-rank-line">
        {site.rank !== undefined && site.score !== undefined ? <>
          <div className="research-rank-card">
            <span>Earth site rank</span>
            <strong aria-label={`Rank ${site.rank} out of ${evaluated}`}>
              {site.rank}<small aria-hidden="true">/ {evaluated}</small>
            </strong>
          </div>
          <span><b>{points(site.score)}/100</b> modeled match · {presets[result.preset]}</span>
        </> : <span>Evaluated Earth route · {presets[result.preset]}</span>}
      </div>
      {reference && margin !== undefined && <p className="research-rank-margin">{Math.abs(margin) < 1e-12
        ? `Tied in modeled score with ${reference.name}.`
        : <><strong>{Math.abs(margin) < .0005 ? 'Less than 0.1 point' : `${points(Math.abs(margin))} points`}</strong> {margin > 0 ? 'ahead of' : 'behind'} {reference.name} under the current weights.</>}</p>}
      <div className="research-explanation">
        <div><h4>Strengths</h4><ul>
          {advantage && reference ? <li><strong>{advantage.label}</strong> is its largest advantage over {reference.name}, worth <b>{points(advantage.advantage)} additional weighted points.</b></li>
            : top && <li><strong>{top.label}</strong> contributed the most to this site’s score, at <b>{points(top.value)} weighted points.</b></li>}
          {features?.slope !== undefined && features.roughness !== undefined && <li>Terrain scores are <b>{points(features.slope)}/100</b> for slope and <b>{points(features.roughness)}/100</b> for roughness.</li>}
          <li>The Earth route is <b>{route.lengthKm.toFixed(2)} km</b>. The lunar route is <b>{result.lunar.lengthKm.toFixed(2)} km</b>.</li>
          {windows > 0 && <li><b>{windows} modeled daylight {windows === 1 ? 'window' : 'windows'}</b> {windows === 1 ? 'meets' : 'meet'} both matching targets.</li>}
        </ul></div>
        <div className="research-limitations"><h4>Limitations</h4><ul>
          <li>{mineralUse(result, site)}</li>
          {windows === 0 && <li>{site.lighting?.closestFrame ? 'The closest modeled daylight falls outside the lighting targets.'
            : 'A comparable daylight window is unavailable for this analysis.'}</li>}
          <li>{site.attempts !== undefined ? `The search attempted routes for ${number.format(site.attempts)} endpoint pairs at this site.` : 'The route comes from a bounded search.'} Smaller hazards need field verification.</li>
        </ul></div>
      </div>
      <div className="mission-callout research-use"><strong>Potential research use</strong><p>{researchUse(result, site)}</p></div>
      <a className="pick-button export-action" href={reportHref} download><Download size={16} aria-hidden="true" /> Download analysis report</a>
    </> : <p className="chart-caption">{site ? site.reason ?? 'This site needs an eligible route before AstroScan can explain its match.'
      : 'Select an Earth site to inspect what supports the match and which field tests it could inform.'}</p>}
  </section>;
}

export function RankingStability({ result }: { result: Analysis }) {
  const stability = useMemo(() => testRankingStability(result), [result]);
  const leader = stability.sites?.find(site => site.rank === 1);
  const changes = stability.sites?.some(site => site.rank > 1 && site.wins > 0);
  return <section className="profile research-panel ranking-stability" aria-labelledby="ranking-stability-title">
    <div className="profile-heading"><h3 id="ranking-stability-title" tabIndex={-1}>Ranking stability</h3><span>{presets[result.preset]}</span></div>
    <p className="chart-caption">How often each Earth site places first when the importance of the scoring features changes.</p>
    {stability.sites ? <>
      <div className="research-stability-summary">
        {leader && <p><strong>{leader.name}</strong>, the current leader, places first in <strong>{leader.wins} of {stability.total}</strong> scenarios.</p>}
        {changes && <p>At least one other route reaches first place under the tested weights.</p>}
      </div>
      <ul className="research-stability-list">
        {stability.sites.map(site => <li key={site.id}>
          <div><strong>{site.name}</strong><span><b>{site.wins}</b> / {stability.total} · {percent(site.wins / stability.total)}</span></div>
          <progress max={stability.total} value={site.wins} aria-label={`${site.name} first-place scenarios`} />
        </li>)}
      </ul>
      {stability.tiedScenarios > 0 && <p className="chart-caption">{stability.tiedScenarios} {stability.tiedScenarios === 1 ? 'scenario has' : 'scenarios have'} a tie. Each tied site receives first-place credit.</p>}
      <details className="evidence-list terrain-method"><summary>How the scenarios are tested</summary>
        <p>AstroScan starts with the current weights, then transfers 5 or 10 percentage points from one active feature to another wherever the starting weight permits it. Each scenario uses the same Earth routes and measured scores.</p>
        <p>These percentages count first-place results within this set of tests. They describe sensitivity to weights. Other uncertainties include terrain resolution, measurement gaps, and the scope of the Earth search.</p>
      </details>
    </> : <p className="research-unavailable">{stability.reason}</p>}
  </section>;
}
