import { test } from "node:test";
import assert from "node:assert";
import { isValidResolution, getHexDisk } from "../shared/h3.js";
import { latLngToCell } from "h3-js";

test("H3 logic - isValidResolution", () => {
  // A resolution 4 hex for some coordinates
  const res4Hex = latLngToCell(37.775938721, -122.417950621, 4);
  const res6Hex = latLngToCell(37.775938721, -122.417950621, 6);

  assert.strictEqual(isValidResolution(res4Hex, 4), true, "Res 4 should be valid for res 4");
  assert.strictEqual(isValidResolution(res6Hex, 4), false, "Res 6 should be invalid for res 4");
  assert.strictEqual(isValidResolution("invalid", 4), false, "Invalid string should be false");
});

test("H3 logic - getHexDisk radius 2", () => {
  const center = latLngToCell(37.775938721, -122.417950621, 4);
  const disk = getHexDisk(center, 2);

  // radius 2 disk should have 19 hexes (1 center + 6 first ring + 12 second ring)
  assert.strictEqual(disk.length, 19, "Disk of radius 2 should have 19 hexes at resolution 4");
  assert.ok(disk.includes(center), "Disk should include the center");
});
