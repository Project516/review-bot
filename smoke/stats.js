// Mean of a non-empty list of numbers.
export function mean(xs) {
  if (xs.length === 0) throw new RangeError("mean of an empty list");
  let sum = 0;
  for (let i = 0; i < xs.length; i++) sum += xs[i];
  return sum / xs.length;
}

// Largest value in a non-empty list of numbers.
export function max(xs) {
  if (xs.length === 0) throw new RangeError("max of an empty list");
  let best = xs[0];
  for (const x of xs) if (x > best) best = x;
  return best;
}
