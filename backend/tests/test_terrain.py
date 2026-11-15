import json
from io import BytesIO
from tempfile import TemporaryDirectory
from time import monotonic, sleep
import unittest
from unittest.mock import patch
from pathlib import Path
from zipfile import ZipFile

import numpy as np
from fastapi.testclient import TestClient

from api.main import app
from src.config import FRONTEND, MAX_LENGTH, REGIONS
from src.lunar_regions import LUNAR_REGIONS
from src.lunar_terrain import tiles_for_bounds
from src.pipeline import AnalysisError, compute, snap_endpoints
from src.routing import route_ab, snap_to_valid
from src.scoring import score_terrain
from src.science import apply_preset
from src.terrain import load_grid


class TerrainTests(unittest.TestCase):
    def test_sldem_tile_selection_crosses_zero_and_the_date_line(self):
        equator = list(tiles_for_bounds(-1, -1, 1, 1))
        self.assertEqual(len(equator), 4)
        self.assertEqual({shift for _, shift, _ in equator}, {-360, 0})
        date_line = list(tiles_for_bounds(179, 10, 181, 11))
        self.assertEqual([key.rsplit('_', 2)[1:] for key, _, _ in date_line], [['135', '180'], ['180', '225']])

    def test_routing_blocks_corner_cutting_and_steep_steps(self):
        dem = np.zeros((2, 2), dtype=np.float32)
        valid = np.array([[True, False], [False, True]])
        self.assertEqual(route_ab(dem, dem, valid, (0, 0), (1, 1)), [])
        valid[:] = True
        dem[1, 1] = 100
        self.assertEqual(route_ab(dem, np.zeros_like(dem), valid, (0, 0), (1, 1)), [])

    def test_lunar_computed_length_retries_shortest_path(self):
        points = {"A": {"lat": 26.19, "lon": 3.47}, "B": {"lat": 26.12, "lon": 3.70}}
        cells, _ = snap_endpoints(points)
        grid = load_grid("moon")
        short = route_ab(grid.dem, grid.rough, grid.valid, *cells)
        detour = (short + short[-2::-1]) * 6 + short
        with patch("src.pipeline.route_ab", side_effect=[detour, short]) as routing:
            result = compute(cells)
            self.assertEqual(routing.call_count, 2)
            self.assertLess(result["lunar"]["lengthKm"], 10)
        with patch("src.pipeline.route_ab", return_value=detour):
            with self.assertRaisesRegex(AnalysisError, "exceeds 75 km"):
                compute(cells)

    def test_serenitatis_route_longer_than_50_km_finds_earth_matches(self):
        points = LUNAR_REGIONS["serenitatis"]["example"]
        cells, _ = snap_endpoints(points, "serenitatis")
        result = compute(cells, region_id="serenitatis")
        self.assertEqual(result["lunarRegion"]["id"], "serenitatis")
        self.assertGreater(result["lunar"]["lengthKm"], 50)
        self.assertLessEqual(result["lunar"]["lengthKm"], 75)
        self.assertTrue(any(candidate["status"] == "matched" for candidate in result["candidates"]))
        with self.assertRaisesRegex(AnalysisError, "outside the Hadley"):
            snap_endpoints(points)

    def test_serenitatis_rejects_endpoints_over_75_km_apart(self):
        points = {"A": {"lat": 24.8, "lon": 16.2}, "B": {"lat": 24.8, "lon": 19.9}}
        with self.assertRaisesRegex(AnalysisError, "more than 75 km apart"):
            snap_endpoints(points, "serenitatis")

    def test_snap_honors_true_radius(self):
        valid = np.zeros((5, 5), dtype=bool)
        valid[2, 2] = True
        self.assertIsNone(snap_to_valid(valid, 0, 0))
        self.assertEqual(snap_to_valid(valid, 2, 0.1), (2, 2))

    def test_similarity(self):
        values = {"slope": np.array([0, 1, 2]), "roughness": np.array([0.1, 0.2])}
        self.assertEqual(score_terrain(values, values)[1], 1)
        different = {key: value * 7 for key, value in values.items()}
        self.assertLess(score_terrain(values, different)[1], 1)

    def test_geographic_round_trip(self):
        grid = load_grid("moon")
        lon, lat = grid.geographic(290, 178)
        row, col = grid.project({"lat": lat, "lon": lon})
        np.testing.assert_allclose([row, col], [290, 178], atol=1e-7)

    def test_replay_profiles_and_ranks(self):
        ranks = []
        for case in ("hadley", "rille"):
            path = FRONTEND / "public" / "replay" / case / "analysis.json"
            result = json.loads(path.read_text())
            self.assertEqual(result["mode"], "replay")
            ranks.append([c["id"] for c in result["candidates"]])
            self.assertEqual(set(ranks[-1]), set(REGIONS))
            self.assertLessEqual(result["lunar"]["lengthKm"] * 1000, MAX_LENGTH)
            for route in [result["lunar"], *(c["route"] for c in result["candidates"])]:
                self.assertGreaterEqual(route["corridor"]["coverage"], .95)
                self.assertAlmostEqual(route["profile"][-1]["distanceKm"], route["lengthKm"])
                self.assertLessEqual(route["steepestDeg"], 20)
            for candidate in result["candidates"]:
                with ZipFile(path.with_name("rover_navigation-" + candidate["id"] + ".zip")) as report:
                    self.assertEqual(json.loads(report.read("analysis.json")), result)
                    self.assertIn(candidate["name"], report.read("report.md").decode().splitlines()[0])
        self.assertNotEqual(*ranks)


class APITests(unittest.TestCase):
    def test_global_name_lookup_is_independent_of_terrain(self):
        with TestClient(app) as client:
            tycho = client.get('/lunar-location', params={'lat': -43.311, 'lon': -11.36}).json()
            self.assertEqual(tycho['feature']['name'], 'Tycho')
            self.assertTrue(tycho['terrainSupported'])
            polar = client.get('/lunar-location', params={'lat': 89, 'lon': 90}).json()
            self.assertIsNotNone(polar['feature'])
            self.assertFalse(polar['terrainSupported'])
            rejected = client.post('/analyses', json={'lunarRegion': 'auto',
                'a': {'lat': 89, 'lon': 90}, 'b': {'lat': 89.01, 'lon': 90}})
            self.assertEqual(rejected.json()['detail']['code'], 'outside_coverage')

    def test_live_analysis_and_export(self):
        points = {"a": {"lat": 26.19, "lon": 3.47}, "b": {"lat": 26.12, "lon": 3.70}}
        with TemporaryDirectory() as cache, patch("api.main.CACHE", Path(cache)), TestClient(app) as client:
            self.assertEqual(client.get("/health").status_code, 200)
            config = client.get("/config").json()
            self.assertEqual(config["maxRouteKm"], 75)
            self.assertEqual({region["id"] for region in config["lunarRegions"]}, {"hadley", "serenitatis"})
            for endpoint, code in [({"lat": 0, "lon": 0}, "outside_coverage"),
                                   (points["a"], "identical_endpoints")]:
                rejected = client.post("/analyses", json={**points, "b": endpoint})
                self.assertEqual(rejected.status_code, 422)
                self.assertEqual(rejected.json()["detail"]["code"], code)
            too_far = client.post("/analyses", json={
                "a": {"lat": 25.41, "lon": 2.51}, "b": {"lat": 26.99, "lon": 4.89},
            })
            self.assertEqual(too_far.status_code, 422)
            self.assertEqual(too_far.json()["detail"]["code"], "length_limit")
            start = client.post("/analyses", json=points)
            self.assertEqual(start.status_code, 202)
            url = f"/analyses/{start.json()['id']}"
            status = start.json()
            deadline = monotonic() + 30
            while status["status"] in ("queued", "running") and monotonic() < deadline:
                sleep(.1)
                status = client.get(url).json()
            self.assertEqual(status["status"], "complete", status)
            result = status["result"]
            self.assertEqual(result["endpoints"]["A"]["requested"], points["a"])
            exported = client.get(url + "/report?site=pinacate")
            self.assertEqual(exported.status_code, 200)
            with ZipFile(BytesIO(exported.content)) as archive:
                self.assertEqual(json.loads(archive.read("analysis.json")), result)
                self.assertEqual(json.loads(archive.read("earth-routes.geojson"))["type"], "FeatureCollection")
                self.assertEqual(json.loads(archive.read("lunar-route.json"))["body"], "Moon")
            alternate = client.get(url + "/report?site=pinacate&preset=camera_lighting")
            with ZipFile(BytesIO(alternate.content)) as archive:
                self.assertEqual(json.loads(archive.read("analysis.json")), apply_preset(result, "camera_lighting"))
                self.assertIn("Camera / lighting", archive.read("report.md").decode())
            repeated = client.post("/analyses", json=points).json()
            self.assertEqual(repeated["result"], result)


    def test_timeout_has_a_structured_result(self):
        from subprocess import TimeoutExpired
        points = {"a": {"lat": 26.19, "lon": 3.47}, "b": {"lat": 26.12, "lon": 3.70}}
        with TemporaryDirectory() as cache, patch("api.main.CACHE", Path(cache)), TestClient(app) as client:
            with patch("api.main.subprocess.run", side_effect=TimeoutExpired("terrain worker", 30)):
                started = client.post("/analyses", json=points).json()
                url = f"/analyses/{started['id']}"
                for _ in range(20):
                    status = client.get(url).json()
                    if status["status"] == "failed":
                        break
                    sleep(.05)
                self.assertEqual(status["error"]["code"], "timeout")
