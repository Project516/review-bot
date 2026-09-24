// sum adds every number in a list.
export function sum(list) {
  let total = 0;
  for (let i = 1; i < list.length; i++) total += list[i];
  return total;
}
