export const DRAFT_POLL_MS = 5_000;
export const DRAFT_MAX_BACKOFF_MS = 5 * 60 * 1_000;

export function shouldStopDraftPolling(draftState) {
  return draftState === 'predraft' || draftState === 'complete';
}

export function draftPollBackoffMs({ failureCount, retryAfterMs = 0, random = Math.random }) {
  const failures = Math.max(1, Number(failureCount) || 1);
  const jitter = 0.75 + Math.max(0, Math.min(1, Number(random()) || 0)) * 0.5;
  const clientDelay = Math.min(
    DRAFT_MAX_BACKOFF_MS,
    Math.round(DRAFT_POLL_MS * (2 ** Math.min(6, failures - 1)) * jitter),
  );
  return Math.min(DRAFT_MAX_BACKOFF_MS, Math.max(clientDelay, Number(retryAfterMs) || 0));
}
