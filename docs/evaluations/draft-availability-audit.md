# Draft board availability and ranking audit (2026-10-14)

**Live reproduction:** not possible from the development sandbox. There is no authenticated Yahoo league session, and the ESPN/NBA history feeds behind expected games are not reachable here. Cade Cunningham's live rank (about #30, as reported) was therefore **not reproduced**. The diagnosis below comes from the code, plus illustrative histories that model the shape of his record (one injury-shortened season among healthy ones). They are not verified game counts.

## How a draft score is built (Yahoo draft board)
1. **FPPG:** `projectPlayer` (existing model). It uses the player's last completed season per-game line, scored with the league's own categories. Recent form is blended only once current-season games exist, so preseason uses last season only.
2. **Expected games:** `estimateExpectedGames` (durability.js), from per-season games played / eligible team games (`getHistoricalAvailability`; shortened seasons use their observed league maximum), shrunk toward an age/experience cohort baseline.
3. **Season points** = FPPG × expected games.
4. **Draft value** = 70% production (season points ÷ pool max) + 20% replacement (season points above the lowest eligible positional baseline ÷ pool spread) + 5% positional scarcity + 5% roster fit, × a 0.9–1.0 confidence factor.

## Root causes found
1. **Inverted recency in expected games (main cause).** The previous model combined 35% "older career" + 40% last three seasons + 25% cohort baseline. Every season older than three was pooled into one block with a fixed 35% weight. One injury-shortened season four years ago therefore weighed more than the third-most-recent season. On an illustrative Cade-shaped history (healthy recent seasons, one 12-game season four years back), it cost **8.5 expected games** (68.4 → 59.9). That is as much as an injury in the most recent season, worth roughly 350–400 season points for a 40+ FPPG player.
2. **Second injury penalty through confidence.** Draft value was multiplied by a confidence factor whose largest term is `min(1, last-season GP / 40)`. A shortened last season lowered expected games and then lowered value again, by up to about 5%.

## Checked and found correct
- Missed games are counted once per season (games played / eligible games). Missing seasons are never treated as zero, and pre-debut and target seasons are excluded.
- Verified season-ending injuries cap availability once; questionable / day-to-day tags do not invent absences.
- League scoring comes from the league's own stat categories.
- Season selection: projections use the last completed season, and history excludes the target season.
- The 70/20/5/5 components are each normalized to 0–1 and sum to 1. Production and replacement both increase with season points, and scarcity and roster fit are small position-level adjustments. No normalization bug was found. Confidence was the only factor applied multiplicatively.

## Fixes
- Expected games now weight every season by a recency decay (0.6 per year, consistent with the documented 0.5/0.3/0.2 ratio), with a coverage factor so thin histories still lean on the cohort baseline.
- A single low season among two or more normal ones has half its deviation discounted (isolated absence). Recurring low seasons keep full weight.
- History vs baseline stays 75/25.
- Draft value adds back the games-played part of confidence (`confidenceGamesPlayedShortfall`), so availability is priced only once, through expected games.
- The board shows a concise "Ranking factors" line (FPPG × expected games = season points and its rank, availability pattern, and points over replacement).

Illustrative expected games, before → after:

| History | Before | After |
|---|---|---|
| Isolated old injury | 59.9 | 66.7 |
| Healthy equivalent | 68.4 | 68.8 |
| Durable star | 74.7 | 74.6 |
| Recurring absences | 52.5 | 51.5 |
| Isolated recent injury | 61.4 | 63.3 |

## Who else is affected
Any player with a single injury-shortened season older than three seasons, or a short last season (the confidence penalty). These players rise. Players with recurring absences stay roughly where they were or drop slightly. Durable players are essentially unchanged.

## Limits
- The decay (0.6), coverage (4 seasons) and isolated discount (0.5) are principled defaults. They have **not** been validated on real availability histories, which are not accessible here.
- `backtestAvailabilityModels` can compare them on the live cached history once it is run in an environment with that data.
