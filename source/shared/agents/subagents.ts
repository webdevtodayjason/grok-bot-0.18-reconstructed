export const SAND_SUBAGENT_ID_PREFIX = "sand-subagent-";

export function isSandSubagentId(id: string): boolean {
  return id.startsWith(SAND_SUBAGENT_ID_PREFIX);
}

// DISPLAY-1b. Window assignments are keyed by whoever owns the seat, and the guard on that file
// used to be a shape rule ("eight or more id-ish characters"), which the literal string
// "undefined" satisfies -- the exact junk key that once held a display for good. Both kinds of
// owner are minted from randomUUID, so the id itself is the test.
const SAND_ID_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSandWindowOwnerId(id: string): boolean {
  return SAND_ID_UUID_PATTERN.test(
    isSandSubagentId(id) ? id.slice(SAND_SUBAGENT_ID_PREFIX.length) : id,
  );
}
