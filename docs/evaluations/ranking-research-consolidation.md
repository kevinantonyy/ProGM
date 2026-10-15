# Ranking research consolidation and implementation plan

No production code, flags or formulas were changed. No new ranking formula is proposed. All numbers below come from
documents already in this folder plus one new offline analysis (section 1 and the section 2 error breakdown), run on the
scratch research dataset.

## Evidence legend
- **[REAL-LEAGUE]** the user's saved 12-team Yahoo snapshot (real roster slots, Yahoo eligibility, production
  outputs). Used for: Cade/Bam/Sengun traces, center scarcity share, replay fidelity, rookie/classifier checks.
- **[RESEARCH]** public NBA game-log dataset (2014-2026, scratch only, licence unresolved), **assumed Yahoo-default
  points scoring**, positions from height/starter labels, assumed lineup. Used for every backtest. Games played
  does not depend on scoring, so the games result (section 1) transfers; per-game and positional results transfer only
  in direction, not magnitude.
- No actual league scoring or Yahoo eligibility exists in any backtest. Treat all backtest magnitudes as indicative.

## 1. Expected-games overprediction (+6 to +8 games)
Sample: 2,743 player-seasons 2018-2026 (players with 800+ prior-season minutes; 2020/21 normalised to 72 games),
production `durability.js` replica (max diff 0 games vs production).

| Finding | Number |
|---|---|
| Mean bias, all players | **+6.6 games** (every season +3.8 to +8.0) |
| Players who played 0 games next season | 5.6% of sample; predicted ~58 games each |
| Share of bias from zero-game players (exits: retired, cut, overseas, injured all year) | **~3.3 of 6.6 games (half)** |
| Bias among players who did play | +3.5 games |
| Bias by projected availability bin (<=.7 / .7-.8 / .8-.9 / >.9) | pred 52/60/67/72 vs observed 49/53/59/69 |

Diagnosis: **calibration, not a bug and not missing seasons.** Half is unmodelled exits (the cohort baseline is
estimated only from players who stayed in the pool, so nobody can ever pull it toward zero); the other half is general
optimism of the recency-weighted history (players selected for having played a lot regress toward their cohort).
It does not come from denominators (checked), stale injuries or the isolated-absence discount.

**Correction tested (rolling-origin: fit on seasons before S, test on S, 2021-2026):** one multiplicative factor
`c = sum(observed games) / sum(predicted games)`.

| | bias (games) | RMSE (games) | MAE (games) |
|---|---|---|---|
| current | +6.2 | 22.16 | 16.13 |
| scale by c (fitted c = 0.88-0.89 every fold) | -0.7 | **21.25** | 16.93 |
| linear a + b*pred | -0.5 | - | 16.91 |
| two-part (P(plays) x games-if-played) | -0.6 | - | 16.84 |

- RMSE improves in 6 of 6 folds (19.47->18.44, 22.57->21.21, 23.30->22.58, 21.37->21.32, 21.51->20.59, 24.71->23.36).
  MAE gets worse (+0.8) because games are bimodal (exits at 0): a mean-unbiased forecast is the right target for
  season totals, a median-like one wins on MAE. Season value is a mean, so RMSE/bias is the right criterion.
- The factor is very stable (0.880 to 0.894). The two-part and linear variants add nothing over one scalar.
- **Ranking impact is tiny:** Spearman of corrected vs current games is 0.998. A uniform shrink scales every player's
  season points (and replacement levels) alike. The correction matters for **absolute season totals** (trade/waiver
  value, replacement-aware work, displayed projections), not for draft order. It also removes the reason replacement-aware
  valuation looked unfavourable: stars with low expected games were already over-ranked.
- Caveat: calibrated on a 800+ minute pool; the live pool (582 incl. low-minute players) may need its own factor,
  so refit on the production pool definition before use.

## 2. Projected points per game
Production (`projection.js`): `expected = 0.35*recent + 0.65*season` per stat, then league scoring. In a preseason draft
"season" is last season and "recent" a recent window of it. Findings:
- It is **last-season carry-forward with a mild recency tilt.** There is no aging, minutes/role forecast, regression
  or team-change input. ESPN `age` and `debutYear` are already fetched for availability but unused by the projection.
- [RESEARCH] last-season line replica ("existing"; the 0.35 in-season recent blend was not reproducible from the
  historical data, so the true production model may be slightly better or worse): n=1,931 players with 15+ games,
  per-game MAE 4.30, bias +0.64, Spearman vs realised totals 0.675 (dev) / 0.629 (holdout).
- Biggest error sources, largest first:
  1. **Minutes/role change.** Error is correlated -0.86 with next-season minutes change. Players whose minutes drop
     4+ are over-projected by 7.0 pts/game (n=445); minutes up 4+ under-projected by 7.0 (n=247). Same-role players
     (+-1.5 mpg, n=576) have 2.4 MAE. Role change is most of the error and is only partly predictable.
  2. **Age.** Bias by age: <=22 -2.4, 23-24 -0.8, 25-27 0.0, 28-30 +1.4, 31+ **+2.8** pts/game.
  3. **Elite regression.** Top-40 by projection are over-projected on average (+0.9 pts).
- A research prototype (age/regression/minutes shrinkage, decay-weighted multi-season) lowers MAE 4.30 -> 4.09
  (base) / 4.01 (+minutes fix), Spearman +0.03, and removes the age bias (<= +-0.4 in all age groups). Top-50 overlap
  is unchanged (0.70) and top-100 +0.02-0.03: the gain is accuracy of the number, not different top-ten names.
  The prototype cannot be shipped as is (trained on licensed data), but age is a runtime field, so a published-literature-style
  or self-fitted age adjustment from ProGM's own stored seasons is the evidence-supported low-risk piece.
- Not testable here: team changes (no trade/transaction data), preseason injury news, depth-chart changes.

## 3. Positional scarcity: is centre scarcity double counted?
**Yes, by construction, and it is the largest structural ranking defect found.**
- Replacement value = starters-th best eligible player at the position (supply-driven). Scarcity bonus =
  starters / eligible supply, min-max rescaled so the scarcest position always gets the full bonus (supply-driven).
  Same quantity counted twice.
- [REAL-LEAGUE] the min-max rescaling gives every C-eligible player the maximum scarcity component: a flat **+4.9 value
  points** regardless of quality. That equals ~1.5 ranks at the top, ~13 at ranks 11-50, ~42 at 51-150, ~70 at 151-300.
  Bam 6->7 and Sengun 7->11 when it is removed (top-band behaviour); centres move 40 ranks on average because the tail dominates.
- [RESEARCH] 2024-25 -> 2025-26, n=414: legacy over-values centres by **-40 ranks** (predicted minus realised rank);
  removing the term: -3.8. Spearman vs realised 0.594 -> 0.608 (bootstrap CI -0.001..+0.030, not significant);
  top-50 overlap 0.52 -> 0.58. An absolute (non-min-max) variant did not fix the bias (-42).
- Conclusion: v2 (0.75/0.20/0/0.05) is supported on structure and bias. Accuracy gain is not statistically proven;
  it is a bias/structure fix, not a prediction breakthrough. Do not redefine replacement level yet.

## 4. Rookie estimates
They are provisional forecasts, and should stay low-confidence (0.3) and visibly labelled.
- [RESEARCH] ADP-implied OLS (`perGame ~ a + b ln ADP`): rookie season-total MAE ~370-394 pts vs 528 for a constant,
  Spearman 0.66; P(plays) calibration under-predicts for the lowest-ranked rookies (pred .47 vs obs .67).
  In-sample on veterans' fit; no true rookie holdout of the fitted ADP line.
- [REAL-LEAGUE] classification by Yahoo player number cutoff found 8 qualifying rookies; ordering reliability evidence was
  produced by the offline tool but the saved-snapshot run of the final pipeline has not been reviewed.
- Needed before enabling: (1) review the user's snapshot run (`rookies`, `yahooPlayerNumberEvidence`, `fidelityOfReplay`);
  (2) UI estimate badge shipped and verified in all three tabs; (3) a held-out check that the ADP line predicts
  rookie output (past drafts' ADP is not stored in-repo, so start logging ADP snapshots now); (4) circularity
  suppression kept (market comparison neutral); (5) rookies limited to the classifier output and excluded when OUT/IL;
  (6) games for rookies calibrated separately (86% played at least once, uncertain count).
- Draft-pick based rookie models stay blocked: no runtime draft position or licensed training data.

## 5. Replacement-aware valuation (context)
Not recommended as default (breakeven true coverage rho ~0.3-0.5, unverifiable without roster/transaction data).
Revisit only after sections 1-2 corrections.

## Prioritised plan

| # | Milestone | Why / evidence | Risk | Acceptance criteria (measurable) |
|---|---|---|---|---|
| 1 | **Validate and shadow `PROGM_RANKING_MODEL=v2` (no scarcity bonus) on the real league** | Only change with a demonstrated structural defect (double count, flat +4.9 bonus, -40 rank centre bias), already implemented and tested; needs real-league confirmation only | Low (flag, default off) | On the saved snapshot: replay fidelity (legacy replay equals app ranks, or differences explained by rounding); C-eligible players' mean rank change reported by rank band with top-25 overlap >= 22/25 and top-50 >= 44/50 vs legacy; no player outside the stat pool changes; 394+ server tests pass; shadow diagnostic runs with flags off in prod unchanged |
| 2 | **Games calibration factor** | Removes ~6.6-game optimism; RMSE better in 6/6 folds; but rank-neutral (Spearman 0.998) | Low | Refit c on the production pool definition; bias within +-1 game and RMSE no worse than current in every rolling fold; rank Spearman vs current >= 0.995; factor recorded with its fit season and refit yearly; also shown on documented displays of projected games |
| 3 | **Age adjustment to per-game projection** (ESPN age is already available) | Age bias -2.4 to +2.8 pts/game; largest cheap fix; prototype removes it | Medium (changes ranks; needs own fitted curve, not licensed data) | Fit on ProGM-stored seasons or published curves; rolling-origin per-game MAE <= current in >= 5 of 6 folds, bias within +-0.5 in every age group, top-50 overlap vs realised not lower by more than the CI; league scoring used when available |
| 4 | **Minutes/role information** (depth, preseason injury, team change) | Largest error source (r=-0.86 with minutes change) but needs data not currently in the pipeline | Higher | Define available runtime inputs first; prove they explain >= 10% of residual variance out of sample before use |
| 5 | **Rookie estimates, staged** | Provisional; UI badge exists in code | Medium | The five prerequisites in section 4 pass; keep 0.3 confidence; ADP logging started |
| 6 | Replacement-aware valuation | Only if real coverage can be measured | Higher | Measured rho from real roster/transaction data >= 0.5 and backtest wins on disagreement pairs |

## Recommended next milestone: #1 (v2 shadow validation on the real league)
It is the only change that fixes a verified, large, structural ranking distortion (the double-counted centre bonus),
it needs no new data or modelling, it is already behind a default-off flag, and everything else (games calibration, age)
is either rank-neutral or builds a new model. Doing #1 first also gives a clean baseline for measuring #2 and #3.
Milestone #2 is the smallest follow-up and can ship in the same release cycle because it does not move draft order.

## Limitations of this consolidation
Research data is not the user's league (assumed scoring, coarse positions, unverified licence); the "existing"
projection replica lacks the in-season recent blend; games calibration was fitted on the 800+ minute pool; one rookie
backtest shares data with the ADP fit; all holdouts are single seasons.
