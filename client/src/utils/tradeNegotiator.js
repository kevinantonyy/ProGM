// Football trade negotiator gate. The negotiator writes the user's selected ESPN players, the trade partner and ProGM's grade into the
// question it sends to the AI provider. ESPN league data must not reach an external AI while sharing rights are unresolved
// (docs/evaluations/deployment-readiness.md), so the feature is OFF unless the build sets VITE_PROGM_TRADE_NEGOTIATOR=allow.
// Enabling it needs the same permission/consent decision as the Yahoo switch; the deterministic trade grade never depends on it.
export const tradeNegotiatorEnabled = (env = import.meta.env) => env?.VITE_PROGM_TRADE_NEGOTIATOR === 'allow';
