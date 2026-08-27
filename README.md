# ProGM

ProGM is a Yahoo Fantasy decision-support app for Fantasy Football and Fantasy Basketball.

## Features

- Separate **Football** and **Basketball** tabs
- **Overview**: Yahoo roster + league settings
- **Start / Bench**: position-aware recommendations with evidence and named sources
- **Trades**: scans other Yahoo league rosters for comparable-value trade targets that improve weak positions
- **Draft**: ranks currently available Yahoo players using expert data, league scoring, and roster construction

## Data sources

- **Yahoo Fantasy Sports API**: league settings, teams, rosters, available players, injury designations, transactions
- **FantasyNerds**: expert consensus rankings, weekly/draft projections, ADP, injuries, add/drop trends, and related professional data

## Upgrade/setup

1. Copy your existing working `.env` into this folder.
2. Run `npm install`.
3. Run `npm start`.
4. Keep your HTTPS tunnel (such as ngrok) running.
5. Make sure `YAHOO_REDIRECT_URI` in `.env` exactly matches the callback registered in Yahoo Developer.
6. Open ProGM from the same tunnel domain used for Yahoo OAuth.

## Notes

- Football scoring format is inferred from Yahoo settings when possible (standard, half-PPR, PPR, Superflex).
- Trade scanning loads only when you open the Trades tab because it must read all league rosters.
- FantasyNerds data availability depends on season timing and your API plan.
- Never commit `.env` or expose API secrets in browser-side JavaScript.
