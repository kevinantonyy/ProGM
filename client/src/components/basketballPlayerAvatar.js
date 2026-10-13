export function avatarSources(player) {
  const candidates = [
    { url: player?.highResImage, kind: 'highRes' },
    { url: player?.image, kind: 'yahoo' },
    { url: player?.headshotUrl, kind: 'yahoo' },
  ];
  const seen = new Set();
  return candidates.filter(({ url }) => {
    if (typeof url !== 'string' || !url.trim() || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

export function initialAvatarState(sourceKey, sourceCount) {
  return { sourceKey, sourceIndex: 0, status: sourceCount ? 'loading' : 'fallback' };
}

export function avatarStateReducer(state, action) {
  if (action.type === 'reset') return initialAvatarState(action.sourceKey, action.sourceCount);
  if (action.sourceKey !== state.sourceKey || action.sourceIndex !== state.sourceIndex) return state;
  if (action.type === 'loaded') return { ...state, status: 'loaded' };
  if (action.type === 'reject') {
    const next = state.sourceIndex + 1;
    return next < action.sourceCount
      ? { ...state, sourceIndex: next, status: 'loading' }
      : { ...state, sourceIndex: action.sourceCount, status: 'fallback' };
  }
  return state;
}

export function imageIsSharpEnough({ naturalWidth, naturalHeight, displayWidth, displayHeight, pixelRatio = 1 }) {
  if (![naturalWidth, naturalHeight, displayWidth, displayHeight].every((value) => Number(value) > 0)) return false;
  const density = Math.max(1, Math.min(Number(pixelRatio) || 1, 2));
  return naturalWidth >= Math.ceil(displayWidth * density) && naturalHeight >= Math.ceil(displayHeight * density);
}
