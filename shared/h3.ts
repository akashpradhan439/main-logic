import { gridDistance } from "h3-js";

/**
 * Returns the H3 grid distance (number of hex steps) between two cells.
 * Returns -1 if either cell is invalid.
 */
export function getHexRingDistance(hexA: string | null, hexB: string | null): number {
  if (!hexA || !hexB) return -1;
  try {
    return gridDistance(hexA, hexB);
  } catch {
    return -1;
  }
}
