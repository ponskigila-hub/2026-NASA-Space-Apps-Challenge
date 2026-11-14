import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch
import unittest

import numpy as np
import h5py
import rasterio

from src.config import FRONTEND, MOON_RADIUS
from src.lighting import shadow_at, trace_horizons
from src.minerals import extract_bands, mineral_score
from src.prepare_emit import main as prepare_emit
from src.science import apply_preset, rankings


class ScienceTests(unittest.TestCase):
    def test_hill_casts_shadow_in_sun_direction_and_edges_are_unknown(self):
        terrain = np.zeros((9, 9))
        terrain[4, 5] = 180
        horizons, known = trace_horizons(terrain, np.array([[4, 4]]),
                                         np.array([[0, 1], [0, -1]]), 3, MOON_RADIUS)
        self.assertGreater(horizons[0, 0], 60)
        self.assertEqual(horizons[1, 0], 0)
        self.assertTrue(known.all())
        _, known = trace_horizons(terrain, np.array([[4, 4]]), np.array([[0, 1]]), 5, MOON_RADIUS)
        self.assertFalse(known[0, 0])
        support = np.ones((72, 1), dtype=bool)
        outline = np.zeros((72, 1))
        outline[18, 0] = 30
        shadow, known_fraction, states = shadow_at(outline, support, np.array([1.]), [10., 10., -5.], [90., 270., 90.])
        np.testing.assert_array_equal(shadow, [1, 0, 1])
        np.testing.assert_array_equal(known_fraction, [1, 1, 1])
        np.testing.assert_array_equal(states[:, 0], [1, 0, 1])

    def test_recovers_two_absorptions_and_excludes_invalid_spectra(self):
        nm = np.arange(700, 2501, 10)
        curve = .8 - .2*np.exp(-((nm-970)/65)**2) - .12*np.exp(-((nm-2060)/90)**2)
        masks = np.vstack([curve, curve * np.nan, np.ones_like(curve)])
        bands = extract_bands(nm, masks)
        self.assertEqual(bands["oneMicron"][1].tolist(), [970])
        self.assertEqual(bands["twoMicron"][1].tolist(), [2060])
        self.assertAlmostEqual(bands["oneMicron"][0][0], .25, places=5)
        pair = {key: value[:2] for key, value in bands.items()}
        self.assertEqual(mineral_score(pair, pair), {"oneMicron": 1, "twoMicron": 1})
        self.assertEqual(mineral_score(pair, {}), {})

    def test_emit_import_applies_spatial_and_band_masks(self):
        with TemporaryDirectory() as directory:
            base = Path(directory)
            suffix = "001_20220813T232617_2222515_016.nc"
            reflectance = base / ("EMIT_L2A_RFL_" + suffix)
            mask = base / ("EMIT_L2A_MASK_" + suffix)
            with h5py.File(reflectance, "w") as file:
                file.attrs["geotransform"] = [0, .1, 0, 1, 0, -.1]
                file["reflectance"] = np.full((2, 2, 4), .6)
                file["sensor_band_parameters/wavelengths"] = [720, 740, 960, 2200]
                file["sensor_band_parameters/good_wavelengths"] = [1, 1, 0, 1]
                file["location/glt_x"] = [[1, 2], [1, 0]]
                file["location/glt_y"] = [[1, 1], [2, 0]]
            with h5py.File(mask, "w") as file:
                masks = np.zeros((2, 2, 8), dtype=np.uint8)
                masks[1, 0, 7] = 1
                file["mask"] = masks
                bands = np.zeros((2, 2, 1), dtype=np.uint8)
                bands[0, 1, 0] = 64
                file["band_mask"] = bands
            grid = SimpleNamespace(meta={"bounds": [0, .8, .2, 1]})
            with patch("src.prepare_emit.SCIENCE", base), patch("src.prepare_emit.load_grid", return_value=grid), patch(
                    "sys.argv", ["prepare_emit", "pinacate", str(reflectance), str(mask)]):
                prepare_emit()
            with rasterio.open(base / "spectra/pinacate.tif") as raster:
                bands = raster.read()
            self.assertTrue(np.isfinite(bands[0, 0]).all())
            self.assertTrue(np.isnan(bands[1, 0, 1]))
            self.assertTrue(np.isnan(bands[2]).all())
            self.assertTrue(np.isnan(bands[:, 1]).all())

    def test_shared_ranking_features_and_replay_evidence(self):
        candidates = [
            {"id": "x", "status": "matched", "featureScores": {"slope": .9, "roughness": .9},
             "lighting": {"score": .2}, "minerals": {"bandScores": {"oneMicron": .8, "twoMicron": .9}}},
            {"id": "y", "status": "matched", "featureScores": {"slope": .6, "roughness": .6},
             "lighting": {"score": .8}, "minerals": {"bandScores": {"twoMicron": .2}}},
        ]
        r = rankings(candidates)
        self.assertEqual(r["mineral_mapping"]["sharedBands"], ["twoMicron"])
        self.assertEqual(apply_preset({"rankings": r, "candidates": candidates}, "camera_lighting")["candidates"][0]["id"], "y")
        candidates[1]["lighting"] = None
        candidates[1]["minerals"] = None
        self.assertEqual(rankings(candidates)["camera_lighting"]["weights"], {"slope": .5, "roughness": .5})
        rille = json.loads((FRONTEND / "public/replay/rille/analysis.json").read_text())
        self.assertEqual(rille["lighting"]["status"], "available")
        self.assertTrue(all(c["lighting"]["windows"] for c in rille["candidates"]))
        self.assertTrue(all(c["minerals"]["lithology"]["units"] for c in rille["candidates"]))
        self.assertNotIn("mineral", rille["effectiveWeights"])
        self.assertEqual(rille["minerals"]["spectral"]["status"], "available")
        self.assertEqual(set(rille["minerals"]["spectral"]["bands"]), {"oneMicron", "twoMicron"})
