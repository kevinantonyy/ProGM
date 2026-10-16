# Frozen prospective evaluation: 2026-27 regular season (pre-registration)

Frozen on 2026-10-16, before opening night, with data final through 2025-26. Snapshot: `ml/prospective/2026-27/snapshot-2026.json`,
SHA-256 `e509467a8aafe3fa5231c961d44aa5ff45b41e47e921044f9c58d51f0ada323e` (also in `manifest-2026.json`), code commit `d8958fc`.
The snapshot is never edited or regenerated; later models get a new, separately dated snapshot. **For tamper evidence the branch (or at least this hash) should be recorded somewhere outside this environment before the season starts; nothing has been pushed.**

## Registered models (identical universe and scoring)
| role | id | what it is |
|---|---|---|
| primary | `candidate_tier_shrink` | age + minutes per-game; games = production games for the top 75 by production season total, 0.6 x ML LightGBM + 0.4 x production for the rest (weights fixed in `preregistered-params.json`, chosen from 2017-2025 folds) |
| reference | `production` | last-season line + durability games (what ProGM ships, as replicated) |
| reference | `age_minutes` | experimental age + minutes projection |
| secondary | `ml_lgbm`, `ml_ridge` | stand-alone ML v1 (trained on target seasons 2014-2025) |
| secondary | `ens_all(age_minutes,ml_ridge)` | equal-weight blend |

Universe: the 327 players with 800+ minutes in 2025-26. Scoring: the league weights in `league-scoring.json` (hash in the snapshot). Rookies and players under 800 prior minutes are not part of this test.

## Outcomes
After the 2026-27 regular season ends, rebuild the dataset with the same code (`python -m progm_ml build-dataset`, commit `d8958fc` or a later commit that does not change `data.py`) from llimllib/nba_data `playerstats.parquet` (season 2026). Players absent from the season count as 0 games. Fantasy points use the frozen weights; double/triple-doubles from game logs where complete.

## Metrics and decision rule
- Primary comparison: `candidate_tier_shrink` vs `production`.
- Primary metric: Spearman correlation of predicted vs actual season fantasy points (all 327). Co-primary safety metrics: top-50 value capture and top-25 overlap.
- Secondary (descriptive): games MAE, RMSE and bias; minutes MAE (10+ games); FP/G MAE (15+ games); season FP MAE; top-25/50 overlap and capture; ML native 80% interval coverage for games and minutes; all models against both references.
- Uncertainty: paired player-level bootstrap (10,000 resamples, seed 2027) for every difference.
- Decision: the candidate qualifies for account-scoped **shadow** testing only if the Spearman difference's 95% interval is above 0 **and** the top-50 capture difference is above -0.02 **and** top-25 overlap is not lower by more than 2 players. One season has low power for top-N metrics; a null result means "not shown", not "worse".
- Only this primary comparison drives the decision; everything else is reported without correction and labelled exploratory.
- Interim looks (e.g. at the All-Star break) are descriptive only and cannot change the decision rule or the snapshot.

## Known limitations of this test
One season; one data source family; no injury or transaction information in any model; the universe excludes rookies and low-minute players; the production replica differs from shipped production in the ways listed in `ml-top-player-diagnostics.md` section 4.

## Freeze record (verified 2026-10-16)
- Snapshot `snapshot-2026.json` SHA-256: `e509467a8aafe3fa5231c961d44aa5ff45b41e47e921044f9c58d51f0ada323e` (matches `manifest-2026.json`).
- Reproducibility check: the dataset was rebuilt from llimllib/nba_data commit `2b4de94ead7568e2aa312115ca7b77ec2ca053ca` (rows identical; only the acquisition timestamp differs), both ML models were retrained for 2026 (predictions identical), and the snapshot was regenerated from those inputs with the recorded code and generation time: byte-identical, same SHA-256.
- Frozen files and their SHA-256 values are listed in `ml/prospective/2026-27/FROZEN.sha256`, which also covers this plan. A server test (`prospectiveFreeze.test.js`) fails if any of them changes. Frozen: the evaluation rules and decision rule (this document), the player pool (in the snapshot), the model weights (`preregistered-params.json`, also recorded in each model version), the league scoring (`league-scoring.json`), and the primary metric (Spearman of season fantasy points, `candidate_tier_shrink` vs `production`).
