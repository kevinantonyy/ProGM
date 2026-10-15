# Replacement-aware draft valuation — prototype evaluation

Status: **prototype, offline only. Not wired into production, no flag enabled, expected-games weights unchanged.**

## Question
Does the draft value undervalue elite per-game players because missed games are
valued at zero? The availability model itself (expected games) was audited and
works as designed (`expected-games-audit.md`); this evaluates changing how
missed games are *valued*.

## Method (`replacementAware.js`)
For a player with expected games `g`, per-game production `pg`, and replacement
per-game `r` (the replacement level of the player's eligible starting slots, from
the league's roster slots and team count):

    slotOutput = g·pg + (82 − g)·ρ·r

`ρ` is the share of missed games that a replacement actually covers (ρ=0 is the
current model). Scenarios:

| scenario | ρ | fill rule | replacement depth |
|---|---|---|---|
| current | 0 | – | – |
| constrained_low | .25 | min over eligible slots | waiver (starters + bench share) |
| constrained_mid | .50 | min | waiver |
| flexible_high | .75 | max | starter-level |
| perfect_bound | 1.0 | max | starter-level |

"Min" models lineup constraints (the weakest eligible slot sets the
replacement); "max" models flexible UTIL/bench use. Players with no slot info
are left untouched. The replacement-adjusted points feed the unchanged
baseline / scarcity / value pipeline (`replayPipeline` with `replacement`).

## Offline illustration (2025-26 lines, 327 players, production-model games)
Current ranks: Wembanyama 4, Sengun 7, Bam 8, Cade 11, Jalen 21, Kawhi 26, Embiid 67.

| scenario | top25/50/100 overlap with current | Cade | Jalen | Bam | Sengun | Embiid |
|---|---|---|---|---|---|---|
| constrained_low | 24 / 47 / 98 | 8 | 19 | 10 | 7 | 49 |
| constrained_mid | 23 / 46 / 97 | 8 | 13 | 12 | 7 | 38 |
| flexible_high | 22 / 43 / 92 | 7 | 9 | 13 | 8 | 22 |
| perfect_bound | 21 / 40 / 89 | 7 | 8 | 18 | 9 | 13 |

Mean rank gain by projected games (fewest / middle / most): low +5.1/−1.2/−3.6,
mid +9.9/−2.2/−7.5, high +19.1/−3.3/−16.4, bound +25.9/−3.8/−24.8.
Movers up: injury-prone stars (George, Embiid, Zion). Down: high-availability
mid-tier players (Bridges, Camara, Reid, DiVincenzo).

Bam does **not** rise (he already projects ~70 games and loses to the shift);
the effect is concentrated in low-games stars.

## Backtest (dev 2018–2024, holdout 2025-26)
Realized "slot value" cannot be observed without roster/waiver data, so true
coverage ρ is unidentifiable from player data. Backtest therefore varies the
*true* ρ and scores each ranking against the modeled realized value.
Pairwise concordance on pairs where current and ρ=.5 rankings disagree
(current / replacement-aware wins):

| true ρ | dev | holdout 2025-26 (not independent) |
|---|---|---|
| 0 | .53 / .47 | .56 / .44 |
| .25 | .50 / .50 | .55 / .45 |
| .5 | .455 / .545 | .50 / .50 |
| .75 | .41 / .59 | .42 / .58 |
| 1.0 | .38 / .62 | .40 / .60 |

- Break-even true ρ ≈ 0.3–0.5. Below it the change is worse; against raw season
  points (ρ=0) it is strictly worse.
- With existing projections, low-games stars are already over-ranked because
  games are over-predicted by ~6–8 (players who exit); at ρ=.5 their absolute
  error worsens (41.0→42.2). With prototype projections it improves (35.7→33.0).

## Assumptions / limitations
Positions from height buckets; Yahoo-default scoring assumed; no real league
roster, waiver or injury-timing data; ρ is a free parameter; single holdout
season; research data licensing unresolved (scratch only, not in repo).

## Answer
It mostly **moves injury-prone stars up**. Whether that is a real prediction
gain depends entirely on how well managers replace missed games (ρ ≳ 0.3–0.5);
the data available cannot confirm that, and it demotes durable mid-tier players.

## Recommendation
1. Do not make it the default; no production change.
2. If wanted, expose as an explicitly experimental flagged option
   (ρ≈0.5, lineup-constrained, waiver depth), default off.
3. First fix the games over-prediction bias, then validate ρ on real league
   roster/transaction data.

## Run on the saved snapshot
    cd server && node scripts/snapshotCompare.mjs ~/workspace-response.json ~/progm-out

Share (after reading for private data): `progm-offline-pipeline.json`
(`replacementAware`, `fidelityOfReplay`, `rookieSensitivity`,
`yahooPlayerNumberEvidence`, `rookies`, `bands`), `progm-ranking-comparison.json`,
`progm-sanitized-snapshot.json`. Do not share the raw response, HAR, or URLs
containing league/team keys.
