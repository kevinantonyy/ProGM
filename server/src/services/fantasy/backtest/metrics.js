function finite(value) {
  return value != null && Number.isFinite(Number(value)) ? Number(value) : null;
}

export function regressionMetrics(pairs) {
  const usable = (pairs || [])
    .map(([predicted, actual]) => [finite(predicted), finite(actual)])
    .filter(([predicted, actual]) => predicted != null && actual != null);
  if (!usable.length) return { count: 0, mae: null, rmse: null };
  const absolute = usable.reduce((sum, [predicted, actual]) => sum + Math.abs(predicted - actual), 0);
  const squared = usable.reduce((sum, [predicted, actual]) => sum + (predicted - actual) ** 2, 0);
  return {
    count: usable.length,
    mae: Number((absolute / usable.length).toFixed(4)),
    rmse: Number(Math.sqrt(squared / usable.length).toFixed(4)),
  };
}

function ranks(values) {
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result = new Array(values.length);
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end].value === sorted[start].value) end += 1;
    const rank = (start + 1 + end) / 2;
    for (let index = start; index < end; index += 1) result[sorted[index].index] = rank;
    start = end;
  }
  return result;
}

export function spearmanCorrelation(pairs) {
  const usable = (pairs || [])
    .map(([predicted, actual]) => [finite(predicted), finite(actual)])
    .filter(([predicted, actual]) => predicted != null && actual != null);
  if (usable.length < 2) return { count: usable.length, correlation: null };
  const predictedRanks = ranks(usable.map(([predicted]) => predicted));
  const actualRanks = ranks(usable.map(([, actual]) => actual));
  const meanP = predictedRanks.reduce((sum, value) => sum + value, 0) / usable.length;
  const meanA = actualRanks.reduce((sum, value) => sum + value, 0) / usable.length;
  let numerator = 0;
  let denominatorP = 0;
  let denominatorA = 0;
  for (let index = 0; index < usable.length; index += 1) {
    const p = predictedRanks[index] - meanP;
    const a = actualRanks[index] - meanA;
    numerator += p * a;
    denominatorP += p ** 2;
    denominatorA += a ** 2;
  }
  const denominator = Math.sqrt(denominatorP * denominatorA);
  return {
    count: usable.length,
    correlation: denominator ? Number((numerator / denominator).toFixed(4)) : null,
  };
}
