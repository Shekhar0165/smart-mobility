export const YOLO_CLASSES = [
  "car",
  "van",
  "truck",
  "pedestrian",
  "person_sitting",
  "cyclist",
  "tram",
  "misc",
];

export const DISTANCE_LABEL_IDS = {
  car: 0,
  cyclist: 1,
  pedestrian: 2,
  tram: 3,
  truck: 4,
  van: 5,
};

export function letterboxFrame(video, canvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const width = video.videoWidth;
  const height = video.videoHeight;
  const scale = Math.min(640 / width, 640 / height);
  const resizedWidth = Math.round(width * scale);
  const resizedHeight = Math.round(height * scale);
  const padX = Math.floor((640 - resizedWidth) / 2);
  const padY = Math.floor((640 - resizedHeight) / 2);
  canvas.width = 640;
  canvas.height = 640;
  context.fillStyle = "rgb(114, 114, 114)";
  context.fillRect(0, 0, 640, 640);
  context.drawImage(video, padX, padY, resizedWidth, resizedHeight);

  const rgba = context.getImageData(0, 0, 640, 640).data;
  const input = new Float32Array(3 * 640 * 640);
  const planeSize = 640 * 640;
  for (let pixel = 0; pixel < planeSize; pixel++) {
    const source = pixel * 4;
    input[pixel] = rgba[source] / 255;
    input[planeSize + pixel] = rgba[source + 1] / 255;
    input[planeSize * 2 + pixel] = rgba[source + 2] / 255;
  }
  return {
    input,
    scale,
    padX,
    padY,
    originalWidth: width,
    originalHeight: height,
  };
}

function intersectionOverUnion(a, b) {
  const left = Math.max(a.x1, b.x1);
  const top = Math.max(a.y1, b.y1);
  const right = Math.min(a.x2, b.x2);
  const bottom = Math.min(a.y2, b.y2);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  return intersection / Math.max(areaA + areaB - intersection, 1e-6);
}

export function decodeYoloOutput(
  output,
  { originalWidth, originalHeight, scale, padX, padY },
  confidenceThreshold = 0.4,
  iouThreshold = 0.5,
) {
  const anchors = 8400;
  const channels = 12;
  if (!output || output.length !== anchors * channels) return [];
  const candidates = [];
  for (let index = 0; index < anchors; index++) {
    let classId = 0;
    let confidence = 0;
    for (
      let candidateClass = 0;
      candidateClass < YOLO_CLASSES.length;
      candidateClass++
    ) {
      const score = output[(candidateClass + 4) * anchors + index];
      if (score > confidence) {
        confidence = score;
        classId = candidateClass;
      }
    }
    if (confidence < confidenceThreshold) continue;

    const cx = output[index];
    const cy = output[anchors + index];
    const width = output[anchors * 2 + index];
    const height = output[anchors * 3 + index];
    const x1 = Math.max(
      0,
      Math.min(originalWidth, (cx - width / 2 - padX) / scale),
    );
    const y1 = Math.max(
      0,
      Math.min(originalHeight, (cy - height / 2 - padY) / scale),
    );
    const x2 = Math.max(
      0,
      Math.min(originalWidth, (cx + width / 2 - padX) / scale),
    );
    const y2 = Math.max(
      0,
      Math.min(originalHeight, (cy + height / 2 - padY) / scale),
    );
    if (x2 <= x1 || y2 <= y1) continue;
    candidates.push({ classId, confidence, x1, y1, x2, y2 });
  }

  const kept = [];
  for (const candidate of candidates.sort(
    (a, b) => b.confidence - a.confidence,
  )) {
    if (
      kept.some(
        (selected) =>
          selected.classId === candidate.classId &&
          intersectionOverUnion(selected, candidate) > iouThreshold,
      )
    )
      continue;
    kept.push(candidate);
  }
  return kept.map(({ classId, confidence, x1, y1, x2, y2 }) => ({
    label: YOLO_CLASSES[classId],
    score: confidence,
    box: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 },
  }));
}

export function distanceFeatures(detection, frameWidth, frameHeight) {
  const labelId = DISTANCE_LABEL_IDS[detection.label];
  if (labelId === undefined) return null;
  const { x, y, w, h } = detection.box;
  const boxW = w / frameWidth;
  const boxH = h / frameHeight;
  const cx = (x + w / 2) / frameWidth;
  const cy = (y + h / 2) / frameHeight;
  return [labelId, boxW, boxH, cx, cy, boxW / Math.max(boxH, 0.001)];
}
