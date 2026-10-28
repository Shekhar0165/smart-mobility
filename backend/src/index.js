import "dotenv/config";
import http from "node:http";
import { pathToFileURL } from "node:url";
import express from "express";
import mongoose from "mongoose";
import { Server } from "socket.io";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z, ZodError } from "zod";
import { describeWithGemini } from "./gemini.js";

const app = express();
const server = http.createServer(app);
export const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || "http://localhost:5173" },
});
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || "http://localhost:5173" }));
app.use(express.json({ limit: "650kb" }));
const thresholdsSchema = new mongoose.Schema(
  {
    clear: { type: Number, default: 200 },
    near: { type: Number, default: 100 },
    danger: { type: Number, default: 50 },
  },
  { _id: false },
);
const userSchema = new mongoose.Schema(
  {
    name: String,
    email: { type: String, unique: true, lowercase: true },
    passwordHash: String,
    role: { type: String, enum: ["admin", "caretaker"], default: "caretaker" },
  },
  { timestamps: true },
);
const deviceSchema = new mongoose.Schema(
  {
    deviceId: { type: String, unique: true },
    name: String,
    apiKeyHash: String,
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    config: {
      thresholds: { type: thresholdsSchema, default: () => ({}) },
      intensity: { type: Number, default: 70 },
      sensorsEnabled: {
        left: { type: Boolean, default: true },
        front: { type: Boolean, default: true },
        right: { type: Boolean, default: true },
      },
      buzzer: { type: Boolean, default: false },
    },
    lastSeenAt: Date,
    battery: Number,
  },
  { timestamps: true },
);
const readingSchema = new mongoose.Schema({
  deviceId: { type: String, index: true },
  ts: { type: Date, default: Date.now },
  left: { type: Number, default: null },
  front: { type: Number, default: null },
  right: { type: Number, default: null },
  batteryV: Number,
  batteryPct: Number,
  zone: String,
});
readingSchema.index({ deviceId: 1, ts: -1 });
readingSchema.index({ ts: 1 }, { expireAfterSeconds: 2592000 });
const alertSchema = new mongoose.Schema({
  deviceId: { type: String, index: true },
  type: {
    type: String,
    enum: ["danger", "low_battery", "sos", "sensor_fault", "camera_obstacle"],
  },
  side: String,
  distanceCm: Number,
  label: String,
  source: String,
  ts: { type: Date, default: Date.now },
  acknowledged: { type: Boolean, default: false },
  acknowledgedBy: mongoose.Schema.Types.ObjectId,
  acknowledgedAt: Date,
});
alertSchema.index({ deviceId: 1, ts: -1 });
export const User = mongoose.models.User || mongoose.model("User", userSchema);
export const Device =
  mongoose.models.Device || mongoose.model("Device", deviceSchema);
export const Reading =
  mongoose.models.Reading || mongoose.model("Reading", readingSchema);
export const Alert =
  mongoose.models.Alert || mongoose.model("Alert", alertSchema);
const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});
const visionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  keyGenerator: (req) => req.user?.id || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
});
const cameraAlertLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: (req) => req.user?.id || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
});
const userAuth = (req, res, next) => {
  try {
    req.user = jwt.verify(
      (req.headers.authorization || "").replace(/^Bearer /, "") || "invalid",
      process.env.JWT_SECRET || "dev-only-secret-change-me",
    );
    next();
  } catch {
    res.status(401).json({ error: "Authentication required" });
  }
};
io.use((socket, next) => {
  try {
    socket.data.user = jwt.verify(
      socket.handshake.auth?.token || "",
      process.env.JWT_SECRET || "dev-only-secret-change-me",
    );
    next();
  } catch {
    next(new Error("Authentication required"));
  }
});
io.on("connection", async (socket) => {
  const user = socket.data.user;
  if (user.role === "admin") socket.join("admins");
  else {
    const deviceIds = await Device.find({ owner: user.id }).distinct(
      "deviceId",
    );
    for (const deviceId of deviceIds) socket.join(`device:${deviceId}`);
  }
});
function emitDeviceEvent(deviceId, event, payload) {
  io.to(`device:${deviceId}`).emit(event, payload);
  io.to("admins").emit(event, payload);
}
const adminOnly = (req, res, next) =>
  req.user.role === "admin"
    ? next()
    : res.status(403).json({ error: "Admin role required" });
const deviceAuth = asyncRoute(async (req, res, next) => {
  const key = req.get("x-api-key");
  if (!key) return res.status(401).json({ error: "Device key required" });
  const devices = await Device.find();
  for (const d of devices)
    if (await bcrypt.compare(key, d.apiKeyHash)) {
      req.device = d;
      const wasOffline =
        !d.lastSeenAt || Date.now() - d.lastSeenAt.getTime() >= 15000;
      d.lastSeenAt = new Date();
      await d.save();
      if (wasOffline)
        emitDeviceEvent(d.deviceId, "device:status", {
          deviceId: d.deviceId,
          status: "online",
        });
      return next();
    }
  return res.status(401).json({ error: "Invalid device key" });
});
const reading = z.object({
  deviceId: z.string().min(1).optional(),
  ts: z.coerce.date().optional(),
  left: z.number().min(0).max(500).nullable(),
  front: z.number().min(0).max(500).nullable(),
  right: z.number().min(0).max(500).nullable(),
  batteryV: z.number().min(0).max(20).optional(),
  batteryPct: z.number().min(0).max(100).optional(),
  zone: z.string().max(20).optional(),
});
app.post(
  "/api/auth/login",
  loginLimiter,
  asyncRoute(async (req, res) => {
    const body = z
      .object({ email: z.string().email(), password: z.string().min(1) })
      .parse(req.body);
    const u = await User.findOne({ email: body.email.toLowerCase() });
    if (!u || !(await bcrypt.compare(body.password, u.passwordHash)))
      return res.status(401).json({ error: "Invalid credentials" });
    res.json({
      token: jwt.sign(
        { id: u.id, role: u.role, name: u.name },
        process.env.JWT_SECRET || "dev-only-secret-change-me",
        { expiresIn: "12h" },
      ),
      user: { id: u.id, name: u.name, email: u.email, role: u.role },
    });
  }),
);
app.get(
  "/api/auth/me",
  userAuth,
  asyncRoute(async (req, res) => {
    const u = await User.findById(req.user.id).select("-passwordHash");
    res.json({ user: u });
  }),
);
app.get(
  "/api/health",
  asyncRoute(async (_req, res) =>
    res.status(mongoose.connection.readyState === 1 ? 200 : 503).json({
      server: "ok",
      database:
        mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    }),
  ),
);
const sceneDescription = z
  .object({
    description: z.string().min(1).max(500),
    objects: z
      .array(
        z
          .object({
            label: z.string().min(1).max(80),
            side: z.enum(["left", "front", "right"]),
            estimatedDistanceM: z.number().min(0).max(1000),
            risk: z.enum(["low", "medium", "high"]),
          })
          .strict(),
      )
      .max(20),
    advice: z.string().min(1).max(500),
  })
  .strict();
const mockSceneDescription = {
  description:
    "Mock scene description: Gemini is not configured, so this is not an analysis of the camera image.",
  objects: [],
  advice:
    "Use the local camera detector and sound alerts; those do not require Gemini.",
};
const MAX_VISION_IMAGE_BYTES = 400_000;
app.post(
  "/api/vision/describe",
  userAuth,
  visionLimiter,
  asyncRoute(async (req, res) => {
    const input = z.object({ image: z.string() }).safeParse(req.body);
    if (!input.success)
      return res
        .status(400)
        .json({ error: "A JPEG image data URL is required." });
    const match = input.data.image.match(
      /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/,
    );
    if (!match)
      return res
        .status(400)
        .json({ error: "Image must be a base64 JPEG data URL." });
    const imageBytes = Buffer.from(match[1], "base64");
    if (imageBytes.length > MAX_VISION_IMAGE_BYTES)
      return res
        .status(413)
        .json({ error: "Image must be 400 KB or smaller." });

    if (!process.env.GEMINI_API_KEY)
      return res.json({ ...mockSceneDescription, mode: "mock" });

    try {
      const raw = await describeWithGemini(match[1]);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return res
          .status(502)
          .json({ error: "Gemini returned malformed scene data." });
      }
      const result = sceneDescription.safeParse(parsed);
      if (!result.success)
        return res
          .status(502)
          .json({ error: "Gemini returned invalid scene data." });
      return res.json({ ...result.data, mode: "gemini" });
    } catch {
      return res.status(503).json({
        error:
          "Scene description is unavailable. Local camera alerts are still active.",
      });
    }
  }),
);
app.post(
  "/api/alerts/camera",
  userAuth,
  cameraAlertLimiter,
  asyncRoute(async (req, res) => {
    const data = z
      .object({
        type: z.literal("camera_obstacle").default("camera_obstacle"),
        side: z.enum(["left", "front", "right"]),
        distanceCm: z.number().min(0).max(2000),
        label: z.string().min(1).max(80),
        source: z.literal("laptop-camera").default("laptop-camera"),
      })
      .parse(req.body);
    const filter = req.user.role === "admin" ? {} : { owner: req.user.id };
    const device = await Device.findOne(filter).sort({ createdAt: 1 });
    if (!device)
      return res.status(404).json({
        error: "No assigned device is available for this camera alert.",
      });
    const alert = await Alert.create({
      ...data,
      deviceId: device.deviceId,
    });
    emitDeviceEvent(alert.deviceId, "alert", alert);
    return res.status(201).json({ alert });
  }),
);
app.post(
  "/api/readings",
  deviceAuth,
  asyncRoute(async (req, res) => {
    const batch = z
      .array(reading)
      .min(1)
      .max(60)
      .parse(Array.isArray(req.body) ? req.body : [req.body]);
    const docs = await Reading.insertMany(
      batch.map((r) => ({ ...r, deviceId: req.device.deviceId })),
    );
    req.device.lastSeenAt = new Date();
    if (batch.at(-1).batteryV != null)
      req.device.battery = batch.at(-1).batteryV;
    await req.device.save();
    docs.forEach((d) => emitDeviceEvent(d.deviceId, "reading", d));
    res.status(201).json({ accepted: docs.length });
  }),
);
app.post(
  "/api/alerts",
  deviceAuth,
  asyncRoute(async (req, res) => {
    const data = z
      .object({
        type: z.enum([
          "danger",
          "low_battery",
          "sos",
          "sensor_fault",
          "camera_obstacle",
        ]),
        side: z.enum(["left", "front", "right"]).optional(),
        distanceCm: z.number().min(0).max(500).optional(),
        label: z.string().max(80).optional(),
        source: z.string().max(40).optional(),
        ts: z.coerce.date().optional(),
      })
      .parse(req.body);
    const a = await Alert.create({ ...data, deviceId: req.device.deviceId });
    emitDeviceEvent(a.deviceId, "alert", a);
    res.status(201).json({ alert: a });
  }),
);
app.get("/api/devices/me/config", deviceAuth, (req, res) =>
  res.json({ deviceId: req.device.deviceId, config: req.device.config }),
);
app.get(
  "/api/devices",
  userAuth,
  asyncRoute(async (req, res) => {
    const filter = req.user.role === "admin" ? {} : { owner: req.user.id };
    res.json(await Device.find(filter).select("-apiKeyHash"));
  }),
);
app.patch(
  "/api/devices/:id/config",
  userAuth,
  asyncRoute(async (req, res) => {
    const d = await Device.findById(req.params.id);
    if (!d) return res.status(404).json({ error: "Device not found" });
    if (req.user.role !== "admin" && String(d.owner) !== req.user.id)
      return res.status(403).json({ error: "Forbidden" });
    const patch = z
      .object({
        thresholds: z
          .object({
            clear: z.number().min(100).max(400),
            near: z.number().min(50).max(200),
            danger: z.number().min(10).max(100),
          })
          .optional(),
        intensity: z.number().min(0).max(100).optional(),
        sensorsEnabled: z
          .object({ left: z.boolean(), front: z.boolean(), right: z.boolean() })
          .optional(),
        buzzer: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    Object.assign(d.config, patch);
    await d.save();
    res.json({ config: d.config });
  }),
);
app.get(
  "/api/readings",
  userAuth,
  asyncRoute(async (req, res) => {
    const q = z
      .object({
        deviceId: z.string().optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        limit: z.coerce.number().int().min(1).max(5000).default(500),
      })
      .parse(req.query);
    const devices = await Device.find(
      req.user.role === "admin" ? {} : { owner: req.user.id },
    ).select("deviceId");
    const ids = devices.map((d) => d.deviceId);
    res.json(
      await Reading.find({
        deviceId: q.deviceId ? { $in: ids, $eq: q.deviceId } : { $in: ids },
        ts: {
          $gte: q.from || new Date(Date.now() - 86400000),
          $lte: q.to || new Date(),
        },
      })
        .sort({ ts: -1 })
        .limit(q.limit),
    );
  }),
);
app.get(
  "/api/readings/stats",
  userAuth,
  asyncRoute(async (req, res) => {
    const deviceIds = await Device.find(
      req.user.role === "admin" ? {} : { owner: req.user.id },
    ).distinct("deviceId");
    const rows = await Reading.aggregate([
      {
        $match: {
          deviceId: { $in: deviceIds },
          ts: { $gte: new Date(Date.now() - 86400000) },
        },
      },
      {
        $group: {
          _id: { $dateTrunc: { date: "$ts", unit: "hour" } },
          avgDistance: { $avg: { $min: ["$left", "$front", "$right"] } },
          minDistance: { $min: { $min: ["$left", "$front", "$right"] } },
          dangerCount: {
            $sum: { $cond: [{ $eq: ["$zone", "danger"] }, 1, 0] },
          },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    res.json(rows);
  }),
);
app.get(
  "/api/alerts",
  userAuth,
  asyncRoute(async (req, res) => {
    const q = z
      .object({
        type: z
          .enum([
            "danger",
            "low_battery",
            "sos",
            "sensor_fault",
            "camera_obstacle",
          ])
          .optional(),
        acknowledged: z.enum(["true", "false"]).optional(),
      })
      .parse(req.query);
    const ids = await Device.find(
      req.user.role === "admin" ? {} : { owner: req.user.id },
    ).distinct("deviceId");
    res.json(
      await Alert.find({
        deviceId: { $in: ids },
        ...(q.type ? { type: q.type } : {}),
        ...(q.acknowledged ? { acknowledged: q.acknowledged === "true" } : {}),
      })
        .sort({ ts: -1 })
        .limit(500),
    );
  }),
);
app.patch(
  "/api/alerts/:id/ack",
  userAuth,
  asyncRoute(async (req, res) => {
    const a = await Alert.findById(req.params.id);
    if (!a) return res.status(404).json({ error: "Alert not found" });
    const d = await Device.findOne({ deviceId: a.deviceId });
    if (req.user.role !== "admin" && String(d?.owner) !== req.user.id)
      return res.status(403).json({ error: "Forbidden" });
    a.acknowledged = true;
    a.acknowledgedBy = req.user.id;
    a.acknowledgedAt = new Date();
    await a.save();
    res.json({ alert: a });
  }),
);
const demos = new Map();
app.post(
  "/api/demo/start",
  userAuth,
  adminOnly,
  asyncRoute(async (req, res) => {
    if (demos.has(req.user.id)) return res.json({ running: true });
    const d = await Device.findOne();
    if (!d) return res.status(404).json({ error: "Seed a demo device first" });
    const timer = setInterval(async () => {
      const front =
        Math.random() < 0.04
          ? 25 + Math.floor(Math.random() * 25)
          : 120 + Math.floor(Math.random() * 150);
      const left = Math.max(20, front + 15);
      const right = Math.max(20, front - 10);
      const nearest = Math.min(left, front, right);
      const zone =
        nearest < 50
          ? "danger"
          : nearest < 100
            ? "near"
            : nearest < 200
              ? "far"
              : "clear";
      const batteryV = Math.random() < 0.005 ? 3.4 : 3.8;
      const doc = await Reading.create({
        deviceId: d.deviceId,
        ts: new Date(),
        left,
        front,
        right,
        batteryV,
        batteryPct: batteryV < 3.5 ? 10 : 70,
        zone,
      });
      emitDeviceEvent(doc.deviceId, "reading", doc);
      if (zone === "danger") {
        const alert = await Alert.create({
          deviceId: d.deviceId,
          type: "danger",
          side: "front",
          distanceCm: front,
        });
        emitDeviceEvent(d.deviceId, "alert", alert);
      }
      if (batteryV < 3.5) {
        const alert = await Alert.create({
          deviceId: d.deviceId,
          type: "low_battery",
        });
        emitDeviceEvent(d.deviceId, "alert", alert);
      }
      if (Math.random() < 0.002) {
        const alert = await Alert.create({ deviceId: d.deviceId, type: "sos" });
        emitDeviceEvent(d.deviceId, "alert", alert);
      }
    }, 1000);
    demos.set(req.user.id, timer);
    res.json({ running: true, simulated: true });
  }),
);
app.post("/api/demo/stop", userAuth, adminOnly, (req, res) => {
  clearInterval(demos.get(req.user.id));
  demos.delete(req.user.id);
  res.json({ running: false });
});
app.use((err, _req, res, _next) => {
  if (err instanceof ZodError)
    return res.status(400).json({
      error: "Invalid request",
      details: err.issues.map((i) => ({ path: i.path, message: i.message })),
    });
  console.error(err.message);
  res.status(500).json({ error: "Internal server error" });
});
export async function markOfflineDevices(now = new Date()) {
  if (mongoose.connection.readyState !== 1) return 0;
  const cutoff = new Date(now.getTime() - 15000);
  const stale = await Device.find({ lastSeenAt: { $ne: null, $lt: cutoff } });
  for (const device of stale) {
    device.lastSeenAt = null;
    await device.save();
    emitDeviceEvent(device.deviceId, "device:status", {
      deviceId: device.deviceId,
      status: "offline",
    });
  }
  return stale.length;
}
const offlineTimer = setInterval(() => {
  markOfflineDevices().catch((error) =>
    console.error("Offline scan failed:", error.message),
  );
}, 5000);
offlineTimer.unref();
if (
  process.env.NODE_ENV !== "test" &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  mongoose
    .connect(
      process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/smart_mobility",
    )
    .then(() =>
      server.listen(process.env.PORT || 4000, () =>
        console.log(`API listening on ${process.env.PORT || 4000}`),
      ),
    )
    .catch((e) => {
      console.error("MongoDB connection failed:", e.message);
      process.exit(1);
    });
}
export { app, server };
