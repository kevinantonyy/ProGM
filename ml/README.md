# ProGM ML v1 (experimental, offline)

Python trains and backtests; the server only consumes precomputed predictions. Predicts basketball statistics (games, minutes,
per-game stats, double/triple-double rates) - never league fantasy points; the server scores them with the league's exact weights.

Data: llimllib/nba_data (owner-authorized for experimental development). Raw data and artifacts are never committed (`ml/.gitignore`).

```bash
pip install -r requirements.txt
git clone --filter=blob:none https://github.com/llimllib/nba_data /path/nba_data
(cd /path/nba_data && git checkout HEAD -- data/playerstats.parquet data/espn/player_box.parquet)
python -m progm_ml build-dataset --data-dir /path/nba_data/data      # -> artifacts/dataset/{player_seasons.parquet, player_seasons.progm.json, manifest.json}
python -m progm_ml backtest --targets 2017-2025 --kinds lgbm,ridge    # -> artifacts/predictions_{lgbm,ridge}.json (walk-forward)
cd ../server && node src/services/fantasy/backtest/chronoEval.cli.js --data ../ml/artifacts/dataset/player_seasons.progm.json --format json \
  --scoring league-scoring.json --ml ../ml/artifacts/predictions_lgbm.json --ml ../ml/artifacts/predictions_ridge.json --ensembles --targets 2017-2025 --out ../ml/artifacts/eval
cd ../ml && python -m progm_ml.report artifacts/eval/chrono-eval-report.json artifacts/eval/ml_v1_report.md
python -m unittest discover -s tests
```
Results and limitations: `docs/evaluations/ml-v1-evaluation.md`.
