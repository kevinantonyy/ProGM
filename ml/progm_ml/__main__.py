"""python -m progm_ml build-dataset|backtest  (offline only; no network)."""
import argparse
import hashlib
import json
import os

import pandas as pd

from .backtest import run
from .data import write_dataset


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["build-dataset", "backtest"])
    ap.add_argument("--data-dir", default=os.environ.get("NBA_DATA_DIR", ""))
    ap.add_argument("--out", default="artifacts")
    ap.add_argument("--targets", default="2017-2025")
    ap.add_argument("--kinds", default="lgbm,ridge")
    a = ap.parse_args()
    ds = os.path.join(a.out, "dataset")
    if a.command == "build-dataset":
        if not a.data_dir:
            raise SystemExit("--data-dir (the nba_data repository's data/ folder) is required")
        m = write_dataset(a.data_dir, ds)
        print(json.dumps({"seasons": m["seasons"], "ddDerivationCheck": m["ddDerivationCheck"]}))
        return
    df = pd.read_parquet(os.path.join(ds, "player_seasons.parquet"))
    with open(os.path.join(ds, "player_seasons.progm.json")) as f:
        prov = json.load(f)["provenance"]
    ph = hashlib.sha256(json.dumps(prov, sort_keys=True).encode()).hexdigest()[:16]
    lo, hi = (int(x) for x in a.targets.split("-"))
    for kind in a.kinds.split(","):
        doc = run(df, list(range(lo, hi + 1)), kind, ph)
        with open(os.path.join(a.out, f"predictions_{kind}.json"), "w") as f:
            json.dump(doc, f)
        print(kind, len(doc["predictions"]), "predictions", {t: v["trainingRows"] for t, v in doc["folds"].items()})


if __name__ == "__main__":
    main()
