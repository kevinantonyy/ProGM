/** Metrics for the chronological evaluation. Every function is pure; targets are scored separately. */
const T975 = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228, 12: 2.179, 15: 2.131, 20: 2.086, 30: 2.042 };
export function tCritical(df) { if (df < 1) return null; const ks = Object.keys(T975).map(Number).sort((a, b) => a - b); for (const k of ks) if (df <= k) return T975[k]; return 1.96; }

export function errorStats(pairs) {
  const u = pairs.filter(([p, a]) => Number.isFinite(p) && Number.isFinite(a));
  if (!u.length) return { n: 0, mae: null, rmse: null, bias: null };
  const e = u.map(([p, a]) => p - a);
  return { n: u.length, mae: e.reduce((s, x) => s + Math.abs(x), 0) / u.length, rmse: Math.sqrt(e.reduce((s, x) => s + x * x, 0) / u.length), bias: e.reduce((s, x) => s + x, 0) / u.length };
}

function ranks(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const out = new Array(values.length);
  for (let s = 0; s < idx.length;) { let e = s + 1; while (e < idx.length && idx[e][0] === idx[s][0]) e += 1; const r = (s + 1 + e) / 2; for (let k = s; k < e; k += 1) out[idx[k][1]] = r; s = e; }
  return out;
}
export function spearman(pairs) {
  const u = pairs.filter(([p, a]) => Number.isFinite(p) && Number.isFinite(a)); if (u.length < 3) return null;
  const rp = ranks(u.map((x) => x[0])); const ra = ranks(u.map((x) => x[1])); const n = u.length;
  const mp = rp.reduce((s, v) => s + v, 0) / n; const ma = ra.reduce((s, v) => s + v, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0; for (let i = 0; i < n; i += 1) { sxy += (rp[i] - mp) * (ra[i] - ma); sxx += (rp[i] - mp) ** 2; syy += (ra[i] - ma) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/** Top-N overlap and value capture of the predicted top N against the actual top N (ties broken by player id for determinism). */
export function topN(rows, n, predKey, actualKey) {
  const ok = rows.filter((r) => Number.isFinite(r[predKey]) && Number.isFinite(r[actualKey])); if (ok.length < n) return null;
  const byP = [...ok].sort((a, b) => b[predKey] - a[predKey] || a.playerId.localeCompare(b.playerId)).slice(0, n);
  const byA = [...ok].sort((a, b) => b[actualKey] - a[actualKey] || a.playerId.localeCompare(b.playerId)).slice(0, n);
  const aSet = new Set(byA.map((r) => r.playerId)); const hit = byP.filter((r) => aSet.has(r.playerId)).length;
  const denom = byA.reduce((s, r) => s + r[actualKey], 0);
  return { overlap: hit / n, capture: denom > 0 ? byP.reduce((s, r) => s + r[actualKey], 0) / denom : null };
}

/** Empirical interval quality: coverage of [lo, hi], mean width and mean pinball loss for the two edges. */
export function intervalStats(items, nominal) {
  const u = items.filter((x) => x.interval && Number.isFinite(x.actual)); if (!u.length) return { n: 0, coverage: null, meanWidth: null, nominal };
  const inside = u.filter((x) => x.actual >= x.interval.lo && x.actual <= x.interval.hi).length;
  return { n: u.length, coverage: inside / u.length, meanWidth: u.reduce((s, x) => s + (x.interval.hi - x.interval.lo), 0) / u.length, nominal };
}

/** Paired per-fold comparison: mean difference with a t interval and the number of folds where `candidate` is better. */
export function pairedFolds(candidate, reference, { lowerIsBetter }) {
  const diffs = []; for (const [fold, v] of Object.entries(candidate)) { if (Number.isFinite(v) && Number.isFinite(reference[fold])) diffs.push(v - reference[fold]); }
  const n = diffs.length; if (!n) return { folds: 0 };
  const mean = diffs.reduce((s, x) => s + x, 0) / n; const sd = n > 1 ? Math.sqrt(diffs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : null;
  const half = n > 1 ? tCritical(n - 1) * sd / Math.sqrt(n) : null;
  return { folds: n, meanDifference: mean, lo: half == null ? null : mean - half, hi: half == null ? null : mean + half, foldsImproved: diffs.filter((d) => (lowerIsBetter ? d < 0 : d > 0)).length };
}
