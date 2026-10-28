import crypto from "node:crypto";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { User, Device } from "./index.js";
await mongoose.connect(
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/smart_mobility",
);
let admin = await User.findOne({ email: "admin@example.com" });
if (!admin)
  admin = await User.create({
    name: "Project Admin",
    email: "admin@example.com",
    passwordHash: await bcrypt.hash("ChangeMe123!", 12),
    role: "admin",
  });
let caretaker = await User.findOne({ email: "caretaker@example.com" });
if (!caretaker)
  caretaker = await User.create({
    name: "Demo Caretaker",
    email: "caretaker@example.com",
    passwordHash: await bcrypt.hash("ChangeMe123!", 12),
    role: "caretaker",
  });
let device = await Device.findOne({ deviceId: "MOBILITY-DEMO-01" });
let apiKey;
if (!device) {
  apiKey = crypto.randomBytes(32).toString("hex");
  device = await Device.create({
    deviceId: "MOBILITY-DEMO-01",
    name: "Simulated Mobility Aid",
    owner: caretaker._id,
    apiKeyHash: await bcrypt.hash(apiKey, 12),
    lastSeenAt: new Date(),
  });
}
console.log("Admin: admin@example.com / ChangeMe123!");
console.log("Caretaker: caretaker@example.com / ChangeMe123!");
if (apiKey) console.log(`Device API key (shown once): ${apiKey}`);
else
  console.log("Demo device already exists; its API key cannot be retrieved.");
await mongoose.disconnect();
process.exit(0);
