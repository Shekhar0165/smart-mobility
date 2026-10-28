import "dotenv/config";
const base = process.env.API_URL || "http://localhost:4000";
const key = process.env.DEVICE_API_KEY;
if (!key) {
  console.error("Set DEVICE_API_KEY from the seed output.");
  process.exit(1);
}
const distance = () => {
  const t = Date.now() / 9000;
  if (Math.random() < 0.02) return Math.round(25 + Math.random() * 20);
  return Math.max(
    60,
    Math.round(155 + Math.sin(t) * 90 + Math.random() * 24 - 12),
  );
};
async function send(path, body) {
  const r = await fetch(`${base}/api/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify(body),
  });
  if (!r.ok) console.error(path, r.status, await r.text());
}
console.log("Sending clearly simulated device readings; Ctrl+C to stop.");
setInterval(async () => {
  const front = distance(),
    left = distance(),
    right = distance();
  const min = Math.min(front, left, right);
  const zone =
    min < 50 ? "danger" : min < 100 ? "near" : min < 200 ? "far" : "clear";
  const batteryV = Math.random() < 0.003 ? 3.4 : 3.75;
  await send("readings", [
    {
      ts: new Date().toISOString(),
      left,
      front,
      right,
      batteryV,
      batteryPct: Math.round(
        Math.max(0, Math.min(100, ((batteryV - 3.3) * 100) / 0.9)),
      ),
      zone,
    },
  ]);
  if (zone === "danger")
    await send("alerts", {
      type: "danger",
      side: front === min ? "front" : left === min ? "left" : "right",
      distanceCm: min,
    });
  if (batteryV < 3.5) await send("alerts", { type: "low_battery" });
  if (Math.random() < 0.002) await send("alerts", { type: "sos" });
}, 1000);
