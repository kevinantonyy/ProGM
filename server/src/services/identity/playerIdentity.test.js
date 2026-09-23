import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeName,
  normalizeTeam,
  buildCanonicalPlayers,
  yahooIdFromKeys,
} from './playerIdentity.js';

test('normalizeName strips accents, punctuation, and suffixes', () => {
  assert.equal(normalizeName('Luka Dončić'), 'luka doncic');
  assert.equal(normalizeName("De'Aaron Fox"), 'deaaron fox');
  assert.equal(normalizeName('Jaren Jackson Jr.'), 'jaren jackson');
  assert.equal(normalizeName('Gary Payton II'), 'gary payton');
  assert.equal(normalizeName('P.J. Tucker'), 'pj tucker');
  assert.equal(normalizeName('Karl-Anthony Towns'), 'karl anthony towns');
});

test('normalizeTeam applies known aliases', () => {
  assert.equal(normalizeTeam('GS'), 'GSW');
  assert.equal(normalizeTeam('NO'), 'NOP');
  assert.equal(normalizeTeam('phx'), 'PHO');
  assert.equal(normalizeTeam('BOS'), 'BOS');
  assert.equal(normalizeTeam(null), null);
});

test('yahooIdFromKeys extracts numeric id from various key shapes', () => {
  assert.equal(yahooIdFromKeys({ editorialPlayerKey: 'nba.p.10290' }), '10290');
  assert.equal(yahooIdFromKeys({ playerKey: '454.p.6175' }), '6175');
  assert.equal(yahooIdFromKeys({ playerId: '999' }), '999');
  assert.equal(yahooIdFromKeys({}), null);
});

test('buildCanonicalPlayers matches by yahoo id first (highest confidence)', () => {
  const source = [{ playerKey: '454.p.10290', playerId: '10290', name: 'Stephon Castle', teamAbbr: 'SAS' }];
  const external = [
    { externalId: 'T1', name: 'Different Name', teamAbbr: 'SAS', yahooId: '10290' },
    { externalId: 'T2', name: 'Stephon Castle', teamAbbr: 'SAS', yahooId: '55555' },
  ];
  const { players, diagnostics } = buildCanonicalPlayers(source, external);
  assert.equal(players[0].externalId, 'T1');
  assert.equal(players[0].matchMethod, 'yahoo_id');
  assert.equal(diagnostics.matched, 1);
  assert.equal(diagnostics.byMethod.yahoo_id, 1);
});

test('buildCanonicalPlayers falls back to name+team when no yahoo id', () => {
  const source = [{ playerKey: '454.p.1', playerId: '1', name: 'Luka Dončić', teamAbbr: 'DAL' }];
  const external = [
    { externalId: 'X', name: 'Luka Doncic', teamAbbr: 'DAL', yahooId: null },
    { externalId: 'Y', name: 'Luka Doncic', teamAbbr: 'LAL', yahooId: null },
  ];
  const { players, diagnostics } = buildCanonicalPlayers(source, external);
  assert.equal(players[0].externalId, 'X');
  assert.equal(players[0].matchMethod, 'name_team');
  assert.equal(diagnostics.byMethod.name_team, 1);
});

test('buildCanonicalPlayers marks ambiguous name+team as unmatched (never guesses)', () => {
  const source = [{ playerKey: '454.p.2', playerId: '2', name: 'John Smith', teamAbbr: 'BOS' }];
  const external = [
    { externalId: 'A', name: 'John Smith', teamAbbr: 'BOS', yahooId: null },
    { externalId: 'B', name: 'John Smith', teamAbbr: 'BOS', yahooId: null },
  ];
  const { players, diagnostics } = buildCanonicalPlayers(source, external);
  assert.equal(players[0].matched, false);
  assert.equal(players[0].externalId, null);
  assert.equal(diagnostics.ambiguous, 1);
  assert.equal(diagnostics.unmatched, 1);
  assert.equal(diagnostics.unmatchedPlayers[0].reason, 'ambiguous');
});

test('buildCanonicalPlayers falls back to unique name-only match', () => {
  const source = [{ playerKey: '454.p.3', playerId: '3', name: 'Nikola Jokic', teamAbbr: 'DEN' }];
  const external = [{ externalId: 'J', name: 'Nikola Jokić', teamAbbr: 'DVR', yahooId: null }]; // team differs
  const { players, diagnostics } = buildCanonicalPlayers(source, external);
  assert.equal(players[0].externalId, 'J');
  assert.equal(players[0].matchMethod, 'name_only');
  assert.equal(diagnostics.byMethod.name_only, 1);
});

test('buildCanonicalPlayers reports no_match and computes match rate', () => {
  const source = [
    { playerKey: '1', playerId: '1', name: 'Matched Guy', teamAbbr: 'BOS' },
    { playerKey: '2', playerId: '2', name: 'Unknown Person', teamAbbr: 'BOS' },
  ];
  const external = [{ externalId: 'M', name: 'Matched Guy', teamAbbr: 'BOS', yahooId: null }];
  const { diagnostics } = buildCanonicalPlayers(source, external);
  assert.equal(diagnostics.total, 2);
  assert.equal(diagnostics.matched, 1);
  assert.equal(diagnostics.unmatched, 1);
  assert.equal(diagnostics.matchRate, 0.5);
  assert.equal(diagnostics.unmatchedPlayers.find((p) => p.name === 'Unknown Person').reason, 'no_match');
});
