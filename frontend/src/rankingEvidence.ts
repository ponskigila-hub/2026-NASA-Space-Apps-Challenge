import type { Analysis, Candidate } from './analysisApi';

export const rankedFeatures = [
  ['slope', 'Hill steepness', '#d4ff59', 'How closely the surrounding ground angles match'],
  ['roughness', 'Bumpy ground', '#93b257', 'How closely ground-height variation matches'],
  ['lighting', 'Sun and shadows', '#a899ff', 'How closely the modeled Sun angle and shadow share match'],
  ['mineral', 'Spectral similarity', '#64ddd1', 'How closely the measured rock signals match'],
] as const;

export type RankingFeature = typeof rankedFeatures[number][0];
export const stabilityTransfers = [.05, .1] as const;

export function rankingFeatureScores(result: Analysis, candidate: Candidate) {
  const shared = result.rankings?.[result.preset]?.sharedBands ?? [];
  const bands = candidate.minerals?.bandScores;
  const sharedScores = shared.map(band => bands?.[band]);
  const mineral = sharedScores.length && sharedScores.every(score => score !== undefined && Number.isFinite(score))
    ? sharedScores.reduce<number>((sum, score) => sum + score!, 0) / sharedScores.length : undefined;
  return {
    slope: candidate.featureScores?.slope,
    roughness: candidate.featureScores?.roughness,
    lighting: candidate.lighting?.score ?? undefined,
    mineral,
  };
}

export function testRankingStability(result: Analysis) {
  const candidates = result.candidates.filter(candidate => candidate.status === 'matched');
  if (candidates.length < 2) return { reason: 'Compare at least two evaluated Earth sites to test ranking stability.' } as const;
  const active = rankedFeatures.map(([key]) => ({ key, weight: result.effectiveWeights[key] ?? 0 })).filter(item => item.weight > 0);
  const weights = active.map(item => item.weight);
  if (weights.length < 2 || Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - 1) > 1e-9) {
    return { reason: 'This analysis needs at least two active features with normalized ranking weights.' } as const;
  }

  const sites = candidates.map(site => {
    const features = rankingFeatureScores(result, site);
    return { site, scores: active.map(({ key }) => features[key] ?? Number.NaN), wins: 0 };
  });
  const score = (scores: number[], scenario: number[]) => scores.reduce((sum, value, index) => sum + value * scenario[index], 0);
  if (sites.some(({ site, scores }) => !Number.isInteger(site.rank) || !Number.isFinite(site.score)
    || scores.some(value => !Number.isFinite(value)) || Math.abs(score(scores, weights) - site.score!) > 1e-9)) {
    return { reason: 'The saved feature scores are incomplete or differ from the displayed ranking, so it cannot be retested.' } as const;
  }

  const scenarios = [weights];
  for (const transfer of stabilityTransfers) {
    for (const [from, weight] of weights.entries()) {
      if (weight < transfer - 1e-12) continue;
      for (const to of weights.keys()) {
        if (to === from) continue;
        const adjusted = [...weights];
        adjusted[from] = Math.max(0, adjusted[from] - transfer);
        adjusted[to] += transfer;
        scenarios.push(adjusted);
      }
    }
  }

  let tiedScenarios = 0;
  for (const scenario of scenarios) {
    const scores = sites.map(site => score(site.scores, scenario));
    const best = Math.max(...scores);
    const first = sites.filter((_, index) => best - scores[index] <= 1e-12);
    if (first.length > 1) tiedScenarios += 1;
    first.forEach(site => { site.wins += 1; });
  }
  return {
    total: scenarios.length,
    tiedScenarios,
    sites: sites.map(({ site, wins }) => ({ id: site.id, name: site.name, rank: site.rank!, wins }))
      .sort((a, b) => b.wins - a.wins || a.rank - b.rank),
  };
}
