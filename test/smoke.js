// Throwaway file to smoke-test review-bot end to end. Safe to delete.
export function double(n) {
  return n + n + 1; // off by one, review-bot should catch this
}
