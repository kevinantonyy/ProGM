import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avatarSources, initialAvatarState, avatarStateReducer, imageIsSharpEnough } from './basketballPlayerAvatar.js';

test('successful image changes loading to the single loaded state', () => {
  const state = initialAvatarState('high|yahoo', 2);
  assert.deepEqual(avatarStateReducer(state, { type: 'loaded', sourceKey: 'high|yahoo', sourceIndex: 0 }), { sourceKey: 'high|yahoo', sourceIndex: 0, status: 'loaded' });
});

test('missing images start directly in fallback', () => {
  assert.deepEqual(initialAvatarState('', 0), { sourceKey: '', sourceIndex: 0, status: 'fallback' });
});

test('failed or undersized images advance once, then fall back', () => {
  const first = initialAvatarState('high|yahoo', 2);
  const second = avatarStateReducer(first, { type: 'reject', sourceKey: 'high|yahoo', sourceIndex: 0, sourceCount: 2 });
  assert.equal(second.sourceIndex, 1);
  assert.equal(second.status, 'loading');
  const fallback = avatarStateReducer(second, { type: 'reject', sourceKey: 'high|yahoo', sourceIndex: 1, sourceCount: 2 });
  assert.equal(fallback.status, 'fallback');
  assert.equal(fallback.sourceIndex, 2);
});

test('source switching resets state and stale image events are ignored', () => {
  const loaded = { sourceKey: 'old', sourceIndex: 0, status: 'loaded' };
  const reset = avatarStateReducer(loaded, { type: 'reset', sourceKey: 'new', sourceCount: 1 });
  assert.deepEqual(reset, { sourceKey: 'new', sourceIndex: 0, status: 'loading' });
  assert.deepEqual(avatarStateReducer(reset, { type: 'loaded', sourceKey: 'old', sourceIndex: 0 }), reset);
});

test('sources prefer verified high resolution, dedupe Yahoo, and reject tiny images', () => {
  assert.deepEqual(avatarSources({ highResImage: 'high.png', image: 'yahoo.png', headshotUrl: 'yahoo.png' }), [
    { url: 'high.png', kind: 'highRes' },
    { url: 'yahoo.png', kind: 'yahoo' },
  ]);
  assert.equal(imageIsSharpEnough({ naturalWidth: 512, naturalHeight: 512, displayWidth: 128, displayHeight: 128, pixelRatio: 2 }), true);
  assert.equal(imageIsSharpEnough({ naturalWidth: 48, naturalHeight: 60, displayWidth: 128, displayHeight: 128, pixelRatio: 1 }), false);
});
