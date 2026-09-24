// max returns the largest number in a non-empty list.
export function max(list) {
  if (!list.length) throw new RangeError("max of an empty list");
  let best = list[0];
  for (const n of list) if (n > best) best = n;
  return best;
}
