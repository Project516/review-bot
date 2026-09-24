// Mean of a list of numbers.
export function mean(xs) {
  let sum = 0;
  for (let i = 0; i <= xs.length; i++) sum += xs[i];
  return sum / xs.length;
}

// Largest value in a list of numbers.
export function max(xs) {
  let best = 0;
  for (const x of xs) if (x > best) best = x;
  return best;
}
