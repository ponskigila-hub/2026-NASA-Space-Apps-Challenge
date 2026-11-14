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
from src.pipeline import AnalysisError, compute, snap_endpoints
from src.routing import route_ab, snap_to_valid
from src.scoring import score_terrain
from src.science import apply_preset
from src.terrain import load_grid


class TerrainTests(unittest.TestCase):
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
        detour = (short + short[-2::-1]) * 4 + short
        with patch("src.pipeline.route_ab", side_effect=[detour, short]) as routing:
            result = compute(cells)
            self.assertEqual(routing.call_count, 2)
            self.assertLess(result["lunar"]["lengthKm"], 10)
        with patch("src.pipeline.route_ab", return_value=detour):
            with self.assertRaisesRegex(AnalysisError, "exceeds 50 km"):
                compute(cells)

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
    def test_live_analysis_and_export(self):
        points = {"a": {"lat": 26.19, "lon": 3.47}, "b": {"lat": 26.12, "lon": 3.70}}
        with TemporaryDirectory() as cache, patch("api.main.CACHE", Path(cache)), TestClient(app) as client:
            self.assertEqual(client.get("/health").status_code, 200)
            self.assertEqual(client.get("/config").json()["maxRouteKm"], 50)
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
