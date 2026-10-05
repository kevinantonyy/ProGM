/**
 * Null expert provider — the ONLY provider registered by default.
 *
 * It is always "disabled" and returns no signals. Its purpose is to let the
 * aggregation/blend plumbing exist and be tested without integrating any real
 * external expert source. Licensed/permitted providers implement the same
 * interface and are registered later (see registry.js).
 */
export const nullExpertProvider = {
  name: 'null',
  isEnabled() { return false; },
  async getSignals() { return []; },
};

export default nullExpertProvider;
