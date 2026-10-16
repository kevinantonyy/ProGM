"""
Exploratory diagnostics (no model selection): top-player games behaviour and the largest top-25/top-50 ranking mistakes.
Inputs: the server evaluation's prediction log (outcome-free) + the dataset (outcomes and prediction-time features).
"""
from __future__ import annotations

import json
import sys

import numpy as np
import pandas as pd

from .features import build_features

W = {"fgm": 2, "ftm": 2, "fg3m": 2, "pts": 1, "oreb": 1.75, "dreb": 1.25, "reb": 1.2, "ast": 2, "stl": 3.25, "blk": 3.75, "tov": -1, "pf": -0.75}


def load(records_path, dataset_path, models):
    R = pd.DataFrame([{**{k: r[k] for k in ("modelId", "targetSeason", "playerId")}, **r["predicted"]} for r in map(json.loads, open(records_path)) if r["modelId"] in models])
    D = pd.read_parquet(dataset_path); D["playerId"] = D.player_id.astype(str)
    D["afp"] = sum(D[f"{k}_pg"] * v for k, v in W.items()) + 3 * D.dd_rate + 5 * D.td_rate
    A = D[["season", "playerId", "gp", "afp", "mpg", "name"]].rename(columns={"season": "targetSeason", "gp": "agp", "mpg": "ampg"})
    R = R.merge(A, on=["targetSeason", "playerId"], how="left")
    R["agp"] = R.agp.fillna(0); R["atot"] = (R.afp * R.agp).fillna(0)
    feats = []
    for t in sorted(R.targetSeason.unique()):
        F = build_features(D[D.season < t], t); F["targetSeason"] = t; F["playerId"] = F.player_id.astype(str); feats.append(F)
    F = pd.concat(feats)[["targetSeason", "playerId", "age_t", "gp_frac_1", "gp_frac_2", "worst_gp_frac", "late20_share_1", "longest_absence_1", "mpg_1", "starter_share_1"]]
    names = D.sort_values("season").groupby("playerId").name.last()
    R = R.merge(F, on=["targetSeason", "playerId"], how="left"); R["name"] = R.playerId.map(names)
    R["rank_pred"] = R.groupby(["modelId", "targetSeason"]).total.rank(ascending=False, method="first")
    R["rank_act"] = R.groupby(["modelId", "targetSeason"]).atot.rank(ascending=False, method="first")
    return R


def slope(x, y):
    x, y = np.asarray(x, float), np.asarray(y, float); ok = np.isfinite(x) & np.isfinite(y)
    return float(np.polyfit(x[ok], y[ok], 1)[0]) if ok.sum() > 10 else None


def games_behaviour(R, ref="production", ml="ml_lgbm", top=60):
    P = R[R.modelId == ref].set_index(["targetSeason", "playerId"]); M = R[R.modelId == ml].set_index(["targetSeason", "playerId"])
    J = P[["games", "agp", "gp_frac_1", "worst_gp_frac", "late20_share_1", "rank_pred", "age_t"]].join(M[["games"]], rsuffix="_ml")
    tier = J[J.rank_pred <= top]; rest = J[J.rank_pred > top]
    out = {}
    for name, g in [("top", tier), ("rest", rest)]:
        out[name] = {
            "n": int(len(g)), "maeProd": float((g.games - g.agp).abs().mean()), "maeMl": float((g.games_ml - g.agp).abs().mean()),
            "biasProd": float((g.games - g.agp).mean()), "biasMl": float((g.games_ml - g.agp).mean()),
            "sdPredProd": float(g.games.std()), "sdPredMl": float(g.games_ml.std()), "sdActual": float(g.agp.std()),
            "corrProd": float(np.corrcoef(g.games, g.agp)[0, 1]), "corrMl": float(np.corrcoef(g.games_ml, g.agp)[0, 1]),
            # how strongly each reacts to last season's availability, vs how strongly outcomes actually follow it (games per unit share)
            "slopeLastSeasonActual": slope(g.gp_frac_1, g.agp), "slopeLastSeasonProd": slope(g.gp_frac_1, g.games), "slopeLastSeasonMl": slope(g.gp_frac_1, g.games_ml),
            "slopeLate20Actual": slope(g.late20_share_1, g.agp), "slopeLate20Ml": slope(g.late20_share_1, g.games_ml),
            "slopeWorstActual": slope(g.worst_gp_frac, g.agp), "slopeWorstMl": slope(g.worst_gp_frac, g.games_ml),
        }
    # error-optimal mix of the two games predictions within the top tier (descriptive only: uses all folds)
    best = min(((w, float(((w * tier.games_ml + (1 - w) * tier.games) - tier.agp).abs().mean())) for w in np.linspace(0, 1, 11)), key=lambda x: x[1])
    out["topTierDescriptiveBestMix"] = {"mlWeight": float(best[0]), "mae": best[1]}
    return out


def mistakes(R, model, n=25, far=50):
    g = R[R.modelId == model].copy()
    fp = g[(g.rank_pred <= n) & (g.rank_act > far)].copy()      # drafted early, finished outside the top 50
    miss = g[(g.rank_act <= n) & (g.rank_pred > far)].copy()    # finished top 25, ranked outside the top 50
    for d in (fp, miss):
        d["games_part"] = d.fppg * (d.agp - d.games)                       # error from games played
        d["rate_part"] = d.atot - d.total - d.games_part                    # error from per-game production
    return fp, miss


def main(records, dataset, out_md):
    models = ["production", "age_minutes", "ml_lgbm", "ml_ridge"]
    R = load(records, dataset, models)
    L = ["# Exploratory diagnostics: top players and ranking mistakes", "", "Exploratory only: these folds were already used to build and compare models.", ""]
    gb = games_behaviour(R)
    L += ["## Games played: production vs ML (LightGBM), top 60 by production's predicted season total each fold", "", "| group | n | MAE prod | MAE ML | bias prod | bias ML | SD pred prod | SD pred ML | SD actual | corr prod | corr ML |", "|---|---|---|---|---|---|---|---|---|---|---|"]
    for k in ("top", "rest"):
        v = gb[k]; L.append(f"| {k} | {v['n']} | {v['maeProd']:.2f} | {v['maeMl']:.2f} | {v['biasProd']:+.2f} | {v['biasMl']:+.2f} | {v['sdPredProd']:.2f} | {v['sdPredMl']:.2f} | {v['sdActual']:.2f} | {v['corrProd']:.3f} | {v['corrMl']:.3f} |")
    L += ["", "Reaction to prediction-time availability signals (games per unit change; top tier):", ""]
    for k in ("top", "rest"):
        v = gb[k]
        L.append(f"- {k}: last-season share -> actual {v['slopeLastSeasonActual']:.1f}, production {v['slopeLastSeasonProd']:.1f}, ML {v['slopeLastSeasonMl']:.1f}; last-20-games share -> actual {v['slopeLate20Actual']:.1f}, ML {v['slopeLate20Ml']:.1f}; worst-season share -> actual {v['slopeWorstActual']:.1f}, ML {v['slopeWorstMl']:.1f}")
    L += ["", f"Descriptive (all folds, not a selection): within the top tier the lowest games MAE is at ML weight {gb['topTierDescriptiveBestMix']['mlWeight']:.1f} (MAE {gb['topTierDescriptiveBestMix']['mae']:.2f}).", ""]
    L += ["## Largest ranking mistakes (top 25 predicted vs finished outside the top 50, and the reverse)", ""]
    for m in models:
        fp, miss = mistakes(R, m)
        def share(d):
            tot = d.games_part.abs().sum() + d.rate_part.abs().sum()
            return d.games_part.abs().sum() / tot if tot else float("nan")
        L.append(f"- **{m}**: {len(fp)} early picks finished outside the top 50 (games explain {share(fp):.0%} of their shortfall; {int((fp.agp < 40).sum())} played under 40 games); "
                 f"{len(miss)} top-25 finishers were ranked outside the top 50 (games explain {share(miss):.0%}).")
    fp, miss = mistakes(R, "production")
    L += ["", "Production's misses, with what was known at prediction time (age, last-season share of games, last-20 share, worst season share):", "", "| season | player | pred rank | final rank | pred games | games | pred FP/G | FP/G | age | last share | last-20 | worst |", "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for d, label in ((fp.sort_values("atot"), "early pick"), (miss.sort_values("rank_pred", ascending=False), "miss")):
        for r in d.head(12).itertuples():
            L.append(f"| {r.targetSeason} | {r.name} ({label}) | {int(r.rank_pred)} | {int(r.rank_act)} | {r.games:.0f} | {r.agp:.0f} | {r.fppg:.1f} | {r.afp if r.afp == r.afp else float('nan'):.1f} | {r.age_t:.0f} | {r.gp_frac_1:.2f} | {r.late20_share_1 if r.late20_share_1 == r.late20_share_1 else float('nan'):.2f} | {r.worst_gp_frac:.2f} |")
    # profile: prediction-time features of production's early-pick busts vs the rest of its top 25
    p = R[(R.modelId == "production") & (R.rank_pred <= 25)].copy(); p["bust"] = p.rank_act > 50
    prof = p.groupby("bust")[["age_t", "gp_frac_1", "gp_frac_2", "worst_gp_frac", "late20_share_1", "mpg_1"]].mean()
    L += ["", "Production's top 25: prediction-time profile of busts (finished outside top 50) vs others:", "", prof.round(3).to_markdown(), ""]
    open(out_md, "w").write("\n".join(L))
    return gb


if __name__ == "__main__":
    main(*sys.argv[1:4])
