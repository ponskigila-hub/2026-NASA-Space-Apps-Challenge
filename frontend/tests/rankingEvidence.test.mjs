import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { rankingFeatureScores, testRankingStability } from '../src/rankingEvidence.ts';

const candidate = (id, rank, slope, roughness, score = (slope + roughness) / 2) =>
  ({ id, name: id, status: 'matched', rank, score, featureScores: { slope, roughness } });
const analysis = (candidates, weights = { slope: .5, roughness: .5 }) =>
  ({ preset: 'rover_navigation', effectiveWeights: weights, candidates });

test('transferring weight can change the leader without modifying the displayed ranking', () => {
  const result = analysis([candidate('A', 1, .82, .6), candidate('B', 2, .65, .73), { id: 'C', status: 'unevaluable' }]);
  const original = structuredClone(result);
  const stability = testRankingStability(result);
  assert.equal(stability.total, 5);
  assert.deepEqual(stability.sites.map(({ id, wins }) => [id, wins]), [['A', 4], ['B', 1]]);
  assert.deepEqual(result, original);
});

test('exact ties credit both sites and one-site comparisons are unavailable', () => {
  const first = candidate('A', 1, 1, 0);
  const second = candidate('B', 2, 0, 1);
  const stability = testRankingStability(analysis([first, second]));
  assert.equal(stability.tiedScenarios, 1);
  assert.deepEqual(stability.sites.map(({ wins }) => wins), [3, 3]);
  assert.match(testRankingStability(analysis([first])).reason, /at least two/i);
});

test('the trial grid skips unaffordable transfers and uses every active shared mineral band', () => {
  const candidates = [candidate('A', 1, 1, 1, .984), candidate('B', 2, 0, 0, 0)];
  candidates[0].minerals = { bandScores: { oneMicron: .8, twoMicron: .4, extra: 1 } };
  candidates[1].minerals = { bandScores: { oneMicron: 0, twoMicron: 0 } };
  const result = analysis(candidates, { slope: .48, roughness: .48, mineral: .04 });
  result.rankings = { rover_navigation: { sharedBands: ['oneMicron', 'twoMicron'] } };
  assert(Math.abs(rankingFeatureScores(result, candidates[0]).mineral - .6) < 1e-12);
  assert.equal(testRankingStability(result).total, 9);
  delete candidates[1].minerals.bandScores.twoMicron;
  assert.equal(rankingFeatureScores(result, candidates[1]).mineral, undefined);
  assert.match(testRankingStability(result).reason, /incomplete/i);
});

test('stability reconstructs the stored baseline for both replays under every objective', () => {
  for (const replay of ['hadley', 'rille']) {
    const data = JSON.parse(readFileSync(new URL(`../public/replay/${replay}/analysis.json`, import.meta.url)));
    for (const [preset, ranking] of Object.entries(data.rankings)) {
      const result = { ...data, preset, effectiveWeights: ranking.weights,
        candidates: data.candidates.map(site => ({ ...site, ...ranking.sites[site.id] })) };
      const stability = testRankingStability(result);
      assert.equal(stability.total, 13);
      assert.equal(stability.sites.find(site => site.rank === 1).wins, 13);
    }
  }
});
