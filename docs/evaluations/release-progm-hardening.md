# Release branch: `release/progm-hardening`

Cut 2026-10-22 from `origin/main` (`f09ca95`). Local only: not pushed, merged or deployed. Personalized Ask ProGM stays OFF (`PROGM_AI_YAHOO_DATA` unset); ESPN data is never shared; Projection Engine V2 is not present.

## What is in it

Production changes from `research/projection-v2-data-rights` (through `e091731`), selected by path, plus the deployment guide:

- Yahoo attribution component and its placement on the Yahoo views.
- Cache retention (Yahoo-derived entries: 15 min stale grace, 24 h hard cap; others 24 h) and sweeper.
- Scheduled deletion of expired Yahoo OAuth state/pending rows.
- Yahoo draft polling: 2 h pick expiry, HTTP 999 backoff kept across cleanup.
- `/api/gm/chat` request validation, JSON-error handling, per-user chat and preview rate limits.
- Server-built, minimized Yahoo league context with recorded, revocable consent (`ai_data_consents`, additive table), preview, consent dialog and focus handling.
- Chat history protections: browser transcripts are never forwarded; only server-issued, user-bound, 10-minute general-chat receipts.
- Docs: `deployment-readiness.md`, `consent-based-gemini-hardening.md`, `consent-based-gemini-implementation.md`, `data-handling-final-review.md`, `data-handling-hardening.md`, `yahoo-attribution-implementation.md`. These were written on the research branch and cite it and its Yahoo probe; the research branch holds that history.

## Not in it

Projection Engine V2 (`server/src/services/projection-v2`, `research/`), research datasets/backtests, the Yahoo probe and its tests, permission-request drafts, data-rights/hoopR reports, design-only documents. Nothing in the production code imports any of them.

## Football trade negotiator

The negotiator is **kept**, not deleted, but off by default. Its prompt contains the selected ESPN players, the trade partner and ProGM's grade, so enabling it would send ESPN league data to Gemini, which is blocked while sharing rights are unresolved.

- `client/src/utils/tradeNegotiator.js`: `tradeNegotiatorEnabled()` is true only when the client is built with `VITE_PROGM_TRADE_NEGOTIATOR=allow`.
- `TradeBuilder.jsx`: with the gate off, `negotiate()` returns before any request and the panel shows "Paused…". The deterministic grade, values, suggestions and "Send to ESPN" are unchanged. The only code changes to the negotiator are the gate and removal of the `league` field (the server has ignored browser-supplied league objects since the data boundary change, and `AIManager` no longer exports the builder).
- Tests: default-off and exact-value gate (`tradeNegotiator.test.js`); the `/gm/chat` caller allowlist now names `TradeBuilder.jsx`, requires the guard, forbids a `league`/`contextRequest` payload.
- Do not set the flag until ESPN sharing is separately approved and consent is designed for it. The gate is a build-time control, not a per-user consent.
