# Data sources: inventory and licensing status

Reviewed from the repository (what each source is used for) and from general knowledge. **No terms of service could be fetched from this environment** (outbound access to vendor sites was blocked), so nothing below is verified. "Unverified" means: do not assume permission for model training, redistribution or commercial use until the owner confirms it from the vendor's current terms.

| Source | Used for in ProGM | Access | Status | Notes / what to confirm |
|---|---|---|---|---|
| Yahoo Fantasy API | The user's own league, rosters, scoring, ADP, ranks | OAuth, user-authorized | Authorized for the app's purpose; ML-training and caching limits unverified | Confirm Yahoo's developer terms on storing responses, deriving models from them, and showing ADP/ranks. Keep requests within the existing guard. |
| ESPN `site.web.api.espn.com` byathlete | Season stats, player directory (age, debut year), historical games played | Undocumented public web endpoint (no key) | Unverified; no published API license found | Highest-risk dependency; the experimental age + minutes feature adds cached requests to it. Confirm terms or replace with a licensed source. |
| NBA CDN static JSON (`cdn.nba.com`) | Schedule and box scores (recent form) | Public static files | Unverified | Confirm NBA.com terms for automated access and reuse. |
| NBA official league totals (stats.nba.com) | OREB/DREB supplement | Public web endpoint, blocks datacenter IPs | Unverified; fallback provider disabled by default | Confirm terms before any bulk historical use. |
| Tank01 via RapidAPI | Player index, stats, schedules | Paid/keyed subscription | Licensed by subscription; scope unverified | Confirm the plan permits caching, derived models and historical retention. |
| BALLDONTLIE | Importer for historical game stats exists; no data stored | API key | Unverified; plan limits unverified | Candidate authorized history source. Its export has no age/experience. Confirm terms for ML use and pagination/rate limits for the plan needed. |
| llimllib `playerstats.parquet` (research dataset) | Offline backtests in scratch only | Public GitHub data | **License unresolved. Not authorized.** | Excluded from the evaluation framework: the framework refuses datasets that are not explicitly authorized or whose `licenseStatus` is `unresolved`. Earlier results that used it are development evidence only. |
| Gemini API | "Ask ProGM" chat | API key | Free-tier content-use terms unverified | Do not send private roster or league data to a free tier. |

## What the new framework enforces
Datasets must carry provenance with `authorized: true`, a permission statement and acquisition time; `licenseStatus: unresolved` is rejected; every prediction record stores the provenance hash and name. This blocks accidental use of the research dataset, but it cannot make a source licensed: the provenance statement is the owner's attestation.

## Decisions needed from the owner
1. Which historical source to authorize for ML v1 (needs: complete league player-season coverage for 8+ seasons, minutes, games, the scored statistics incl. OREB/DREB/DD/TD, and age or birth date).
2. Whether ESPN's feeds are acceptable for production use; if not, a replacement for current-season stats and directory ages.
3. Which paid tier of any chosen vendor is needed and its terms on retention and model training.
