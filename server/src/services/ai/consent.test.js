import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISCLOSURE, DISCLOSURE_VERSION, CONSENT_SCOPE, createConsentStore, createMemoryConsentStore } from './consent.js';

test('the disclosure states every required fact in plain words (free-tier disclosure)', () => {
  const all = JSON.stringify(DISCLOSURE);
  assert.match(DISCLOSURE.google, /free Gemini service/);
  assert.match(DISCLOSURE.google, /improve its products/);
  assert.match(DISCLOSURE.google, /human reviewers may read it/);
  assert.match(DISCLOSURE.google, /cannot delete it from Google/);
  assert.match(DISCLOSURE.optional, /optional/);
  assert.match(DISCLOSURE.revoke, /turn this off at any time/);
  assert.match(DISCLOSURE.revoke, /does not remove information Google has already received/);
  assert.match(DISCLOSURE.yahoo, /still being clarified/);
  assert.match(DISCLOSURE.yahoo, /turn this feature off at any time/);
  assert.match(DISCLOSURE.revoke, /date and this version/);
  for (const topic of [/password|login details/i, /access token/i, /email address/i, /username/i, /Yahoo IDs/, /league, team and manager names/, /Profile pictures/, /ownership percentages, ADP or Yahoo rankings/]) assert.match(all, topic);
  assert.match(all, /Team A/);
  assert.match(all, /6 KB/);
  assert.match(all, /See what was sent/);
  assert.ok(Object.isFrozen(DISCLOSURE));
  assert.equal(DISCLOSURE.version, DISCLOSURE_VERSION);
});

test('the disclosure never promises that turning sharing off deletes what Google received', () => {
  assert.doesNotMatch(JSON.stringify(DISCLOSURE), /(deletes?|removes?|erases?) (all |your |the )?(data|information)(?! Google has already)/i);
});

test('SQL store: grant writes the current version, a stale version is refused, revoke only touches active rows', async () => {
  const calls = [];
  const rows = [];
  const execute = async (sql, params) => { calls.push({ sql, params }); return /^\s*SELECT/i.test(sql) ? [rows] : [{ affectedRows: 1 }]; };
  const store = createConsentStore(execute);
  assert.equal(await store.grant(7, DISCLOSURE_VERSION + 1), false);
  assert.equal(calls.length, 0, 'a stale or forged version writes nothing');
  assert.equal(await store.grant(7, DISCLOSURE_VERSION), true);
  assert.match(calls[0].sql, /INSERT INTO ai_data_consents/);
  assert.match(calls[0].sql, /ON CONFLICT \(user_id, scope\) DO UPDATE/);
  assert.deepEqual(calls[0].params, [7, CONSENT_SCOPE, DISCLOSURE_VERSION]);
  await store.revoke(7);
  assert.match(calls[1].sql, /UPDATE ai_data_consents SET revoked_at = NOW\(\) WHERE user_id = \? AND scope = \? AND revoked_at IS NULL/);
  assert.deepEqual(calls[1].params, [7, CONSENT_SCOPE]);
  assert.equal(await store.hasActiveConsent(7), false, 'no row means no consent');
  assert.equal(await store.hasActiveConsent(null), false);
  rows.push({ disclosure_version: DISCLOSURE_VERSION, granted_at: new Date(), revoked_at: null });
  assert.equal(await store.hasActiveConsent(7), true);
  rows[0].revoked_at = new Date();
  assert.equal(await store.hasActiveConsent(7), false, 'revoked');
  rows[0].revoked_at = null; rows[0].disclosure_version = DISCLOSURE_VERSION - 1;
  assert.equal(await store.hasActiveConsent(7), false, 'an older disclosure version is not consent to the current text');
});

test('memory store has the same contract', async () => {
  const s = createMemoryConsentStore();
  assert.equal(await s.hasActiveConsent(1), false);
  assert.equal(await s.grant(1, 99), false);
  assert.equal(await s.grant(1, DISCLOSURE_VERSION), true);
  assert.equal(await s.hasActiveConsent(1), true);
  assert.equal(await s.hasActiveConsent(2), false, 'per user');
  await s.revoke(1);
  assert.equal(await s.hasActiveConsent(1), false);
  assert.equal(await s.grant(1, DISCLOSURE_VERSION), true, 'consent can be granted again after revoking');
  assert.equal(await s.hasActiveConsent(1), true);
});
