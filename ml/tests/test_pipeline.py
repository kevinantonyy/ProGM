"""Offline tests: no network and no external data (synthetic players only). Run: python -m unittest discover -s tests"""
import unittest

import numpy as np
import pandas as pd

from progm_ml.backtest import fold_predictions, run
from progm_ml.data import derive_from_games, to_progm_rows
from progm_ml.features import RATE_STATS, build_features, labels


def synthetic(players=180, seasons=range(2012, 2020), seed=3):
    rng = np.random.default_rng(seed); rows = []
    for i in range(players):
        age = int(rng.integers(20, 34)); mpg = float(rng.uniform(15, 35)); rate = float(rng.uniform(0.6, 1.4)); fragile = rng.random() < 0.25
        for s in seasons:
            if s > seasons[0] + 1 and rng.random() < 0.06:
                age += 1; continue                                   # absent season
            gp = int(np.clip(rng.normal(55 if fragile else 72, 10), 5, 82)); mt = gp * mpg
            r = {"player_id": i, "season": s, "name": f"P{i}", "team": "AAA", "age": age, "gp": gp, "minutes_total": mt, "mpg": mpg, "usg_pct": 0.2, "pace": 100.0,
                 "draft_year": s - (age - 20), "draft_number": 30.0, "height": 79.0, "season_games": 82, "late20_share": np.nan, "longest_absence": np.nan, "starter_share": np.nan}
            for k, c in enumerate(RATE_STATS):
                r[c] = mt * rate * (0.1 + 0.02 * k)
            r["reb"] = r["oreb"] + r["dreb"]; r["dd2"] = gp * 0.1; r["td3"] = 0.0; r["dd_rate"] = 0.1; r["td_rate"] = 0.0
            rows.append(r)
            age += 1; mpg = float(np.clip(mpg + rng.normal(0, 2), 8, 38)); rate = max(0.2, rate + (0.05 if age < 25 else -0.04) + rng.normal(0, 0.03))
    return pd.DataFrame(rows)


class LeakageTests(unittest.TestCase):
    def test_features_refuse_history_that_reaches_the_target(self):
        df = synthetic()
        with self.assertRaises(ValueError):
            build_features(df[df.season <= 2017], 2017)
        f = build_features(df[df.season < 2017], 2017)
        self.assertTrue(len(f) > 50)

    def test_future_garbage_cannot_change_a_historical_forecast(self):
        df = synthetic(); t = 2017
        a, meta = fold_predictions(df, t, "lgbm", first_training_target=2014)
        g = df.copy().astype({"gp": float, "age": float}); fut = g.season >= t
        rng = np.random.default_rng(0)
        for c in ["gp", "minutes_total", "mpg", "age", "usg_pct"] + RATE_STATS:
            g.loc[fut, c] = rng.uniform(0, 3000, fut.sum())
        g = pd.concat([g, g[fut].assign(player_id=g[fut].player_id + 10000)])   # ghost players in the future
        b, _ = fold_predictions(g, t, "lgbm", first_training_target=2014)
        pd.testing.assert_frame_equal(a.reset_index(drop=True), b.reset_index(drop=True))
        self.assertLess(meta["trainedThroughSeason"], t); self.assertLess(meta["dataCutoffSeason"], t)

    def test_prediction_documents_declare_training_before_target(self):
        doc = run(synthetic(), [2017, 2018], "ridge", "hash", first_training_target=2014)
        self.assertEqual(doc["schema"], "progm.ml-predictions.v1")
        for p in doc["predictions"]:
            self.assertLess(p["trainedThroughSeason"], p["targetSeason"]); self.assertLess(p["dataCutoffSeason"], p["targetSeason"])
            self.assertEqual(p["asOf"], f"{p['targetSeason']}-10-01T00:00:00.000Z")
            self.assertNotIn("fantasyPoints", p)                      # statistics only
            self.assertAlmostEqual(p["statLine"]["rebounds"], p["statLine"]["offRebounds"] + p["statLine"]["defRebounds"], places=6)


class DataTests(unittest.TestCase):
    def test_double_and_triple_doubles_are_derived_from_game_rows(self):
        g = pd.DataFrame([
            {"season": 2020, "game_id": "0022000001", "player_id": 1, "team": "AAA", "starter": 1, "pts": 12, "reb": 11, "ast": 3, "stl": 0, "blk": 0, "minutes": 30},
            {"season": 2020, "game_id": "0022000002", "player_id": 1, "team": "AAA", "starter": 1, "pts": 12, "reb": 11, "ast": 10, "stl": 0, "blk": 0, "minutes": 30},
            {"season": 2020, "game_id": "0022000003", "player_id": 1, "team": "AAA", "starter": 0, "pts": 9, "reb": 11, "ast": 3, "stl": 0, "blk": 0, "minutes": 30},
            {"season": 2020, "game_id": "0022000004", "player_id": 2, "team": "AAA", "starter": 1, "pts": 20, "reb": 2, "ast": 2, "stl": 0, "blk": 0, "minutes": 30},
        ])
        d, comp = derive_from_games(g)
        p1 = d[d.player_id == 1].iloc[0]
        self.assertEqual((p1.dd_games, p1.td_games, p1.games_logged), (2, 1, 3))
        p2 = d[d.player_id == 2].iloc[0]
        self.assertEqual(p2.longest_absence, 0)                         # absences are counted only after the player joined the team
        self.assertAlmostEqual(p1.starter_share, 2 / 3)

    def test_missing_values_stay_missing(self):
        df = synthetic(players=20); df.loc[df.index[:5], "usg_pct"] = np.nan; df["mpg"] = df.minutes_total / df.gp
        for c in RATE_STATS + ["reb"]:
            df[f"{c}_pg"] = df[c] / df.gp
        df.loc[df.index[0], "pts_pg"] = np.nan
        rows = to_progm_rows(df)
        self.assertIsNone(rows[0]["stats"]["points"])
        lab = labels(df[df.season == 2019], pd.Series([0, 999999]))
        self.assertEqual(lab.loc[1, "gp"], 0)                           # absent player = 0 games, other outcomes stay missing
        self.assertTrue(np.isnan(lab.loc[1, "mpg"]))


if __name__ == "__main__":
    unittest.main()
