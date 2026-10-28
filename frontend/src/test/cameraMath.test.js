import { describe, expect, it } from "vitest";
import {
  beepIntervalMs,
  calculateFocalLengthPx,
  estimateDistanceM,
  initialFocalLengthPx,
  zoneForDistance,
} from "../cameraMath.js";

describe("Camera Cane estimates and alert rules", () => {
  it("uses the pinhole formula for estimated distance", () => {
    expect(estimateDistanceM(1.7, 600, 340)).toBeCloseTo(3);
    expect(estimateDistanceM(1.7, 600, 0)).toBeNull();
  });

  it("maps camera distance to zones using the alert-distance thresholds", () => {
    expect(zoneForDistance(0.5, 2)).toBe("danger");
    expect(zoneForDistance(0.9, 2)).toBe("near");
    expect(zoneForDistance(1.8, 2)).toBe("far");
    expect(zoneForDistance(2.1, 2)).toBe("clear");
  });

  it("shortens the beep interval as an obstacle approaches", () => {
    expect(beepIntervalMs(2, 2)).toBe(1200);
    expect(beepIntervalMs(1, 2)).toBeLessThan(beepIntervalMs(2, 2));
    expect(beepIntervalMs(0.5, 2)).toBe(0);
    expect(beepIntervalMs(3, 2)).toBeNull();
  });

  it("calculates and initializes focal length for calibration", () => {
    const focalLength = calculateFocalLengthPx(1.7, 2, 340);
    expect(focalLength).toBeCloseTo(400);
    expect(estimateDistanceM(1.7, focalLength, 340)).toBeCloseTo(2);
    expect(initialFocalLengthPx(640)).toBeGreaterThan(0);
    expect(calculateFocalLengthPx(1.7, 0, 340)).toBeNull();
  });
});
