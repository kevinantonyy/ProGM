import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  basketballChatPayload, footballChatPayload, personalizedChatPayload, answerTag,
  YAHOO_AI_SUBTITLE, YAHOO_AI_INTRO, YAHOO_AI_PERSONAL_SUBTITLE, YAHOO_AI_UNAVAILABLE, ESPN_AI_SUBTITLE,
} from './aiSharing.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('general payload sends only the current question; old saved and personalized history stays display-only', () => {
  const messages = Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? 'gm' : 'user', text: `m${i}`, meta: { sent: 'LEAGUE SUMMARY', sections: ['roster'] } }));
  messages.push({ role: 'user', text: 'New general question' });
  const payload = basketballChatPayload(messages);
  assert.deepEqual(Object.keys(payload), ['messages']);
  assert.equal(payload.messages.length, 1);
  assert.equal(payload.messages.at(-1).text, 'New general question');
  assert.ok(!JSON.stringify(payload).includes('LEAGUE SUMMARY'));
  assert.deepEqual(basketballChatPayload(messages, 'opaque-receipt'), { messages: [{ role: 'user', text: 'New general question' }], historyToken: 'opaque-receipt' });
  assert.deepEqual(Object.keys(payload.messages[0]), ['role', 'text'], 'answer metadata (including a previous league summary) is never sent back');
  assert.deepEqual(basketballChatPayload(undefined), { messages: [] });
  assert.deepEqual(footballChatPayload([{ role: 'user', text: 'hi' }]), { messages: [{ role: 'user', text: 'hi' }] });
});

test('the personalized payload is a request plus two lookup keys: never league data, never a provenance label', () => {
  const p = personalizedChatPayload([{ role: 'user', text: 'Who should I start?', meta: {} }], { leagueKey: '466.l.1', teamKey: '466.l.1.t.2' });
  assert.deepEqual(Object.keys(p), ['messages', 'contextRequest', 'leagueKey', 'teamKey']);
  assert.equal(p.contextRequest, 'yahoo_league');
  assert.deepEqual(p.messages, [{ role: 'user', text: 'Who should I start?' }]);
  assert.deepEqual(Object.keys(personalizedChatPayload([], {})), ['messages', 'contextRequest', 'leagueKey', 'teamKey']);
});

test('the user is told plainly what is and is not shared', () => {
  assert.match(YAHOO_AI_SUBTITLE, /not shared with the AI provider/);
  assert.match(YAHOO_AI_INTRO, /unless you turn on personalization/);
  assert.match(YAHOO_AI_PERSONAL_SUBTITLE, /sent to Google Gemini/);
  assert.match(YAHOO_AI_UNAVAILABLE, /not available right now/);
  assert.match(ESPN_AI_SUBTITLE, /not shared with the AI provider/);
});

test('every answer is tagged so general advice and league-based answers cannot be confused', () => {
  assert.match(answerTag({ shared: false }), /General advice · no league data sent/);
  assert.match(answerTag(undefined), /General advice/);
  assert.equal(answerTag({ shared: true, sections: ['overview', 'lineup', 'waivers'] }), 'Used your league: lineup, waivers · sent to Google Gemini');
  assert.match(answerTag({ shared: true, sections: ['overview'] }), /scoring settings and team rating/);
});

function clientSources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return clientSources(full);
    return /[.]jsx?$/.test(e.name) && !e.name.endsWith('.test.js') ? [full] : [];
  });
}

test('the basketball chat starts with personalization OFF and only ever sends the payload helpers', () => {
  const src = read('../components/AskProGMChat.jsx');
  const chatCalls = src.split('\n').filter((line) => line.includes("'/gm/chat'"));
  assert.equal(chatCalls.length, 1);
  assert.doesNotMatch(chatCalls[0], /league|source|context/i);
  assert.match(src, /personalizedChatPayload\(next, \{ leagueKey, teamKey \}\) : basketballChatPayload\(next, historyToken\)/);
  assert.match(src, /useState\(\{ status: 'loading'/, 'nothing is personalized until the server says so');
  assert.match(src, /const personalized = consent\.status === 'on';/);
  assert.match(src, /api\.post\('\/gm\/consent', \{ version: consent\.version \}\)/, 'consent is recorded by the server, for the version the user saw');
  assert.match(src, /api\.delete\('\/gm\/consent'\)/);
  assert.match(src, /See what was sent/);
  assert.match(src, /Preview what would be sent/);
  assert.doesNotMatch(src, /localStorage|sessionStorage/, 'consent is not kept in the browser');
});

test('the football chat sends the conversation only, and ESPN data cannot ride along in any caller', () => {
  const ai = read('../components/AIManager.jsx');
  const chatCalls = ai.split('\n').filter((line) => line.includes("'/gm/chat'"));
  assert.equal(chatCalls.length, 1);
  assert.match(chatCalls[0], /footballChatPayload\(/);
  assert.doesNotMatch(ai, /league:|leagueContext|source: 'espn'|contextRequest/);
  assert.doesNotMatch(ai, /localStorage\.(getItem|setItem)|data\.connection\?\.teamName/);
  assert.match(ai, /historyToken/);
  const trade = read('../components/TradeBuilder.jsx'); // negotiator code is kept, but only reachable behind the build-time gate
  assert.match(trade, /Paused: the AI negotiator is switched off/);
  assert.match(trade, /if \(!tradeNegotiatorEnabled\(\) \|\|/, 'negotiate() returns before any request while the gate is off');
  assert.equal(trade.split('\n').filter((line) => line.includes("'/gm/chat'")).length, 1);
  assert.doesNotMatch(trade, /league:|leagueContext|contextRequest/, 'no ESPN league object is attached to the request');
});

test('old saved football greetings, identifiers and personalized replies cannot be restored to the outbound payload', () => {
  const oldSaved = [
    { role: 'gm', text: 'I am GM for PRIVATE_ESPN_TEAM' },
    { role: 'gm', text: 'PRIVATE_ESPN_PLAYER has 88 points', meta: { shared: true } },
    { role: 'user', text: 'General flex advice?' },
  ];
  const visibleCopy = JSON.stringify(oldSaved);
  assert.deepEqual(footballChatPayload(oldSaved), { messages: [{ role: 'user', text: 'General flex advice?' }] });
  assert.equal(JSON.stringify(oldSaved), visibleCopy, 'local visible history is not mutated or deleted');
  for (const bad of [null, {}, [null], [{ role: 'gm', text: 'private old answer' }]]) assert.deepEqual(footballChatPayload(bad), { messages: [] });
});

test('every chat caller is known; none sends league data or a provenance label; the old client-built context is gone', () => {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const files = clientSources(root).filter((f) => fs.readFileSync(f, 'utf8').includes("'/gm/chat'"));
  const callers = files.map((f) => path.relative(root, f).split(path.sep).join('/')).sort();
  assert.deepEqual(callers, ['components/AIManager.jsx', 'components/AskProGMChat.jsx', 'components/TradeBuilder.jsx'], 'a new /gm/chat caller must be reviewed against the AI data policy');
  for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.includes("'/gm/chat'")).join('\n'), /league|source|context/i);
  assert.doesNotMatch(read('../pages/BasketballWorkspace.jsx'), /basketballContext|source: 'yahoo'/);
});
