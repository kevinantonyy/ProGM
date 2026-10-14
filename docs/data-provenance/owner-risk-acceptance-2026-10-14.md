# ProGM — Owner Risk Acceptance

Recorded verbatim as supplied by the ProGM owner.

> Date: October 14, 2026
>
> As the owner of ProGM, I acknowledge that the maintainers of the Brescou and llimllib NBA statistics repositories have approved use of their datasets for private storage and machine-learning training.
>
> I understand that the underlying statistics may originate from NBA.com and other third-party sources, and that the maintainers' approvals do not establish authorization from those original providers.
>
> I am willing to accept the potential legal and business risks associated with pursuing internal historical NBA model development, subject to applicable law.
>
> Intended scope:
>
> * Regular-season NBA player game logs from 2015–16 through 2025–26.
> * Private storage for ProGM's internal development.
> * Training and evaluating player-performance prediction models.
> * No public redistribution of raw datasets.
> * No public historical statistics API.
> * Exclusion of unrelated ESPN, Basketball Reference, and other third-party tables.
>
> I understand that objections or legal claims could require stopping use of the data, deleting stored records, and retiring models trained on them.
>
> This statement records my risk tolerance. It is not permission from the NBA, a legal opinion, or a determination that the proposed use is lawful.
>
> Owner: ProGM

## How it is applied

- It is referenced as `writtenPermissionUrl` only by the `llimllib-nba-player-game-logs` source registration (`llimllib-nba-player-game-logs.source.json`). That source covers llimllib's stats.nba.com-derived regular-season player game logs, 2015–16 to 2025–26. llimllib's ESPN, basketball-reference, Cleaning the Glass and dunksandthrees tables are excluded.
- Registration flags: storage, commercialUse (internal ProGM use only), modelTraining = true; redistribution and publicApi = false.
- Upstream (NBA.com) rights remain **unverified**. Provenance describes this as owner risk acceptance plus maintainer permission, never as NBA permission.
- Kill switch: all records carry `source_key = 'llimllib-nba-player-game-logs'`, so the data can be identified and removed together. Retire any model trained on it at the same time.
