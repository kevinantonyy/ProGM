// Whether ESPN-backed features are available. The server decides (GET /api/espn/availability, a static answer that touches neither ESPN nor
// the database). ESPN has declined to permit use of its data, so the answer is "not available" unless the server says exactly `available: true`.
// Any failure to ask is treated as "not available": the UI must never show ESPN controls that cannot work.
export const ESPN_UNAVAILABLE = Object.freeze({
  available: false,
  message: 'ESPN data is not available in ProGM. ESPN has declined to permit use of its data, so ESPN league sync, Fantasy Football, ESPN news and ESPN projections are switched off. Your Yahoo basketball league is not affected.',
});

export function parseEspnAvailability(data) {
  if (data && data.available === true) return { available: true };
  return { available: false, message: typeof data?.message === 'string' && data.message.trim() ? data.message : ESPN_UNAVAILABLE.message };
}

let pending = null;
/** One request per page load, shared by every component. `getJson` returns the response body; it is passed in so this stays testable. */
export function loadEspnAvailability(getJson) {
  pending ||= Promise.resolve().then(getJson).then(parseEspnAvailability, () => ({ ...ESPN_UNAVAILABLE }));
  return pending;
}
export function resetEspnAvailability() { pending = null; }
