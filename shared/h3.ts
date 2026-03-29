import { gridDistance, getResolution, gridDisk } from "h3-js";

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

/**
 * Checks if a hex has the expected resolution.
 */
export function isValidResolution(hex: string, expectedResolution: number): boolean {
  try {
    return getResolution(hex) === expectedResolution;
  } catch {
    return false;
  }
}

/**
 * Returns a grid disk of hexes at a given radius around the center hex.
 * Includes the center hex itself.
 */
export function getHexDisk(hex: string, radius: number): string[] {
  try {
    return gridDisk(hex, radius);
  } catch {
    return [hex];
  }
}
