// max returns the largest number in a non-empty list.
export function max(list) {
  let best = 0;
  for (const n of list) if (n > best) best = n;
  return best;
}
