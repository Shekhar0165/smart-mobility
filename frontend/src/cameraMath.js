export const OBJECT_HEIGHTS_M = {
  person: 1.7,
  // Rough fallback heights for custom KITTI labels without learned distances.
  person_sitting: 1.2,
  misc: 0.8,
  chair: 0.9,
  bottle: 0.25,
  laptop: 0.23,
  door: 2.0,
  car: 1.5,
  bicycle: 1.1,
  motorcycle: 1.2,
  bus: 3.0,
  truck: 3.2,
  couch: 0.9,
  bed: 0.6,
  diningtable: 0.75,
  tv: 0.55,
  pottedplant: 0.6,
  backpack: 0.5,
  suitcase: 0.65,
  bench: 0.5,
  sink: 0.85,
  refrigerator: 1.7,
  oven: 0.85,
  microwave: 0.35,
  toilet: 0.75,
  book: 0.24,
  cellphone: 0.15,
  cup: 0.12,
  bowl: 0.1,
  vase: 0.3,
  handbag: 0.3,
  umbrella: 0.9,
  dog: 0.6,
  cat: 0.3,
};

export function normalizeClass(label = "") {
  return label.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function getTypicalHeight(label) {
  return OBJECT_HEIGHTS_M[normalizeClass(label)] ?? null;
}

export function estimateDistanceM(realHeightM, focalLengthPx, boxHeightPx) {
  if (
    !Number.isFinite(realHeightM) ||
    !Number.isFinite(focalLengthPx) ||
    !Number.isFinite(boxHeightPx) ||
    realHeightM <= 0 ||
    focalLengthPx <= 0 ||
    boxHeightPx <= 0
  )
    return null;
  return (realHeightM * focalLengthPx) / boxHeightPx;
}

export function calculateFocalLengthPx(
  realHeightM,
  knownDistanceM,
  boxHeightPx,
) {
  if (
    !Number.isFinite(realHeightM) ||
    !Number.isFinite(knownDistanceM) ||
    !Number.isFinite(boxHeightPx) ||
    realHeightM <= 0 ||
    knownDistanceM <= 0 ||
    boxHeightPx <= 0
  )
    return null;
  return (knownDistanceM * boxHeightPx) / realHeightM;
}

export function initialFocalLengthPx(videoWidth) {
  if (!Number.isFinite(videoWidth) || videoWidth <= 0) return null;
  // Starting estimate assumes a nominal 60-degree horizontal webcam field of view.
  return videoWidth / (2 * Math.tan((60 * Math.PI) / 360));
}

export function zoneForDistance(distanceM, alertDistanceM) {
  if (!Number.isFinite(distanceM) || !Number.isFinite(alertDistanceM))
    return "clear";
  if (distanceM <= alertDistanceM * 0.25) return "danger";
  if (distanceM <= alertDistanceM * 0.5) return "near";
  if (distanceM <= alertDistanceM) return "far";
  return "clear";
}

export function beepIntervalMs(distanceM, alertDistanceM) {
  if (
    !Number.isFinite(distanceM) ||
    !Number.isFinite(alertDistanceM) ||
    distanceM > alertDistanceM ||
    alertDistanceM <= 0
  )
    return null;
  if (distanceM <= alertDistanceM * 0.25) return 0;
  const ratio = Math.min(1, Math.max(0.25, distanceM / alertDistanceM));
  return Math.round(150 + ((ratio - 0.25) / 0.75) * 1050);
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function sideForBox(centerX, frameWidth) {
  if (
    !Number.isFinite(centerX) ||
    !Number.isFinite(frameWidth) ||
    frameWidth <= 0
  )
    return "front";
  if (centerX < frameWidth / 3) return "left";
  if (centerX > (frameWidth * 2) / 3) return "right";
  return "front";
}
