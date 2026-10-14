# Ranking model flag: Variant A (default) vs Variant B

Server-side flag `PROGM_RANKING_MODEL` selects the draft-value model. Unset, empty
or unknown values mean **A**. `B` (case-insensitive) selects Variant B. There is no
client toggle. Rankings (Overall/ProGM Rank), the Draft Helper board, Draft Priority
and the workspace payload all read the same resolved model, so they cannot disagree.

## Exact formulas (value is 0-100, identical scale in both variants)

Shared components (unchanged): `production = seasonPoints / poolMaxSeasonPoints`,
`replacement = clamp((seasonPoints - bestEligibleReplacementBaseline) / poolSpread)`,
`confidenceFactor = 0.9 + 0.1 * confidence`, `rosterFit` = 0.5 (neutral, baseline) or
the roster-derived need/surplus score when the roster is non-empty.

- **A**: `value = (0.70*production + 0.20*replacement + 0.05*scarcity + 0.05*rosterFit) * confidenceFactor * 100`
- **B**: `value = (0.70*production + 0.20*replacement + 0.00*scarcity + 0.05*rosterFit) * confidenceFactor * 100`

The removed 0.05 is **not redistributed**. Hence, for the same player,
`B = A - 5 * scarcity * confidenceFactor` (scarcity in 0..1), so B scores sit 0 to ~5
points below A and are not directly comparable to stored A numbers. Ranks (what users
see) are unaffected by the offset except through its per-position variation.
The `scarcity` component is still reported in `components` for explainability but
contributes nothing under B.

## Cache identity

- Frozen baseline reference key: `bball:overall-ref:<model>:<league>:<season>:<scoringSig>`;
  the stored reference also carries `model`, and `buildDraftBoard` ignores a reference
  whose model differs from the requested one.
- Workspace cache key: `bball:workspace:<model>:<user>:<league>:<team>`.
- Flipping the flag therefore never serves A data as B or vice versa. Old keys
  (without a model segment) are simply never read again and expire by TTL.

## Offline comparison (production code path, 2024-25 inputs -> 2025-26 realized)

Pool: 414 players, assumed default Yahoo scoring/lineup (NOT any user's league);
derived data only, no dataset re-downloaded. Reproduce with
`node docs/evaluations/ranking-model-compare.mjs <pool.json> 2024`.

| metric | A | B |
|---|---|---|
| Spearman vs realized season total | 0.594 | 0.608 |
| Top-24 overlap with realized | 0.458 | 0.458 |
| Top-50 overlap with realized | 0.52 | 0.58 |
| Center positional bias (ranks, + = undervalued) | -40.4 | -3.9 |
| Forward bias | +24.4 | +17.0 |
| Guard bias | -5.0 | -17.7 |
| Mean abs rank change, 20% pool removed | 0.433 | 0.361 |

Ordering agreement A vs B: Spearman 0.979; top-24 identical sets; 43/50 shared in top 50.
Mean rank shift A->B by primary label: C +36.5 (worse), F -7.5, G -12.7.
Examples: Cade Cunningham 11->9, Bam Adebayo 14->17, Alperen Sengun 9->14, Wembanyama 3->4.

Caveats: B fixes the center over-valuation but shifts bias toward guards (-17.7 from
-5.0); the Spearman gain (+0.015) was not statistically significant in the earlier
bootstrap (CI -0.001..+0.030); single backtest season; scoring/lineup assumed.
Harness note: the older `rankVariants` "B" omits the constant roster-fit term, so its
near-ties can order differently from production B; the script above uses production B.
