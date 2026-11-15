import assert from 'node:assert/strict';
import test from 'node:test';
import { angleGap, lightingGaps, meetsLightingTargets, observationCsv, shadowSegments, shadowStatistics, travelSunShares } from '../src/lightingSimulation.ts';

function route(distances, coords = distances.map(distance => [0, distance / 100])) {
  return {
    lengthKm: distances.at(-1),
    profile: distances.map((distanceKm, i) => ({ distanceKm, point: { lat: coords[i][0], lon: coords[i][1] } })),
  };
}

test('shadow distances use sample midpoints and unknown stretches break continuity', () => {
  const track = route([0, 1, 3, 4, 7, 8, 10]);
  const segments = shadowSegments(track, [0, 1, 2, 3, 4, 5, 6], [0, 1, -1, 1, 0, 1, 1]);
  assert.deepEqual(segments.map(segment => [segment.state, segment.startKm, segment.endKm]), [
    [0, 0, .5], [1, .5, 2], [-1, 2, 3.5], [1, 3.5, 5.5], [0, 5.5, 7.5], [1, 7.5, 10],
  ]);
  assert.deepEqual(shadowStatistics(segments), { longestKm: 2.5, transitions: 2 });
  assert.equal(shadowStatistics(shadowSegments(track, [0, 6], [-1, -1])), undefined);
  assert.deepEqual(shadowStatistics(shadowSegments(track, [0, 6], [0, 0])), { longestKm: 0, transitions: 0 });
  assert.deepEqual(shadowSegments(track, [0, 8], [0, 1]), []);
});

test('Sun direction uses the shorter circular difference and a distance-weighted route heading', () => {
  assert.equal(angleGap(359, 1), 2);
  assert.equal(angleGap(90, -90), 180);
  assert.equal(angleGap(undefined, 90), undefined);
  const track = route([0, 2, 5, 10], [[0, 0], [0, .01], [.01, .01], [.01, 0]]);
  assert.deepEqual(travelSunShares(track, 90, 10), { toward: .2, across: .3, away: .5 });
  assert.equal(travelSunShares(track, 90, 0), undefined);
});

const moon = {
  status: 'available', utc: '2026-11-18T00:00:00Z', elevationDeg: 10, azimuthDeg: 359, shadowFraction: .25, coverage: 1,
};
const frame = {
  utc: '2026-11-19T04:40:00+00:00', local: '2026-11-19T07:40:00+03:00', elevationDeg: 12, azimuthDeg: 1, shadowFraction: .35, coverage: .95,
};

test('window thresholds include their boundaries and require daytime and known coverage', () => {
  assert.equal(meetsLightingTargets(moon, frame), true);
  assert.equal(meetsLightingTargets(moon, { ...frame, elevationDeg: 12.01 }), false);
  assert.equal(meetsLightingTargets(moon, { ...frame, shadowFraction: .36 }), false);
  assert.equal(meetsLightingTargets(moon, { ...frame, coverage: .94 }), false);
  assert.equal(meetsLightingTargets(moon, { ...frame, elevationDeg: 0 }), false);
  assert.equal(meetsLightingTargets({ ...moon, status: 'unavailable' }, frame), false);
  assert.equal(lightingGaps(moon, { ...frame, coverage: 0 }).shadowFraction, undefined);
});

test('export identifies the active snapshot and preserves both time zones and gap units', () => {
  const next = { ...frame, utc: '2026-11-19T04:50:00+00:00', local: '2026-11-19T07:50:00+03:00' };
  const window = { startUtc: frame.utc, endUtc: next.utc, startLocal: frame.local, endLocal: next.local,
    timeZone: 'Asia/Riyadh', frames: [frame, next], bestFrame: 0 };
  const [header, first, second] = observationCsv('Harrat Khaybar', moon, window, 1).trim().split('\r\n').map(row => row.split(','));
  const records = [first, second].map(row => Object.fromEntries(header.map((key, i) => [key, row[i]])));
  assert.deepEqual(records.map(record => record.selected_preview), ['false', 'true']);
  assert.deepEqual(records.map(record => record.best_window_frame), ['true', 'false']);
  assert.equal(records[1].earth_time_zone, 'Asia/Riyadh');
  assert.equal(records[1].earth_time_local, next.local);
  assert.equal(records[1].earth_time_utc, next.utc);
  assert.equal(records[1].sun_azimuth_gap_deg, '2.000000');
  assert.equal(records[1].shadow_gap_percentage_points, '10.000000');
  assert.equal(records[1].meets_lighting_targets, 'true');
  assert(observationCsv('Site, "test"', moon, window, 1).includes('"Site, ""test"""'));
});
