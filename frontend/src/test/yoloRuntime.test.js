import { describe, expect, it } from "vitest";
import { decodeYoloOutput, distanceFeatures } from "../yoloRuntime.js";

describe("YOLO output and learned-distance features", () => {
  it("decodes [1, 12, 8400] output and reverses letterbox padding", () => {
    const output = new Float32Array(12 * 8400);
    const index = 13;
    output[index] = 320;
    output[8400 + index] = 320;
    output[8400 * 2 + index] = 200;
    output[8400 * 3 + index] = 100;
    output[8400 * 4 + index] = 0.9;
    const detections = decodeYoloOutput(output, {
      originalWidth: 640,
      originalHeight: 320,
      scale: 1,
      padX: 0,
      padY: 160,
    });
    expect(detections).toHaveLength(1);
    expect(detections[0].label).toBe("car");
    expect(detections[0].box).toEqual({ x: 220, y: 110, w: 200, h: 100 });
  });

  it("uses the distance model feature order and skips unmapped classes", () => {
    const detection = {
      label: "cyclist",
      box: { x: 100, y: 50, w: 200, h: 100 },
    };
    expect(distanceFeatures(detection, 1000, 500)).toEqual([
      1, 0.2, 0.2, 0.2, 0.2, 1,
    ]);
    expect(
      distanceFeatures({ ...detection, label: "misc" }, 1000, 500),
    ).toBeNull();
  });

  it("filters low confidence and suppresses overlapping boxes of the same class", () => {
    const output = new Float32Array(12 * 8400);
    for (const [index, confidence] of [0.8, 0.7, 0.39].entries()) {
      output[index] = index === 1 ? 322 : 320;
      output[8400 + index] = 320;
      output[8400 * 2 + index] = 200;
      output[8400 * 3 + index] = 100;
      output[8400 * 4 + index] = confidence;
    }
    expect(
      decodeYoloOutput(output, {
        originalWidth: 640,
        originalHeight: 640,
        scale: 1,
        padX: 0,
        padY: 0,
      }),
    ).toHaveLength(1);
  });
});
