import React, { useEffect, useState } from "react";
import {
  Routes,
  Route,
  NavLink,
  Navigate,
  useNavigate,
} from "react-router-dom";
import { io } from "socket.io-client";
import { AnimatePresence, motion } from "framer-motion";
import CameraCane from "./CameraCane.jsx";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  CartesianGrid,
} from "recharts";
const API = import.meta.env.VITE_API_URL || "http://localhost:4000";
async function call(path, opts = {}) {
  const token = localStorage.getItem("token");
  const r = await fetch(API + path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
  });
  if (!r.ok) throw new Error((await r.json()).error || "Request failed");
  return r.json();
}
function Protected({ children, admin = false }) {
  const user = JSON.parse(localStorage.getItem("user") || "null");
  return user && (!admin || user.role === "admin") ? (
    children
  ) : (
    <Navigate to="/login" replace />
  );
}
function Login() {
  const [error, setError] = useState("");
  const nav = useNavigate();
  async function submit(e) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const d = await call("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: f.get("email"),
          password: f.get("password"),
        }),
      });
      localStorage.setItem("token", d.token);
      localStorage.setItem("user", JSON.stringify(d.user));
      nav("/");
    } catch (x) {
      setError(x.message);
    }
  }
  return (
    <main className="login">
      <form className="card" onSubmit={submit}>
        <p className="eyebrow">CARETAKER PORTAL</p>
        <h1>Sign in</h1>
        <label>
          Email
          <input name="email" type="email" required autoComplete="username" />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button>Sign in</button>
        <small>Use the seeded caretaker or admin account.</small>
      </form>
    </main>
  );
}
function Shell({ children }) {
  const user = JSON.parse(localStorage.getItem("user") || "{}");
  return (
    <div className="layout">
      <aside>
        <div className="brand">
          <span>SM</span>
          <div>
            <b>Steady</b>
            <small>Mobility companion</small>
          </div>
        </div>
        <nav>
          {[
            ["/", "Camera Cane"],
            ["/hardware", "Hardware"],
            ["/history", "History"],
            ["/alerts", "Alerts"],
            ["/settings", "Device settings"],
            ...(user.role === "admin" ? [["/demo", "Demo"]] : []),
          ].map(([to, label]) => (
            <NavLink key={to} to={to} end={to === "/"}>
              {label}
            </NavLink>
          ))}
        </nav>
        <button
          className="signout"
          onClick={() => {
            localStorage.clear();
            location.href = "/login";
          }}
        >
          Sign out
        </button>
        <p className="support">Designed to assist a white cane.</p>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
function Live() {
  const [data, setData] = useState(null),
    [alerts, setAlerts] = useState([]),
    [online, setOnline] = useState(false),
    [deviceOnline, setDeviceOnline] = useState(false),
    [simulated, setSimulated] = useState(false);
  useEffect(() => {
    call("/api/readings?limit=1")
      .then((x) => setData(x[0]))
      .catch(() => {});
    call("/api/devices")
      .then((devices) => {
        setSimulated(
          devices.some((device) =>
            device.name.toLowerCase().includes("simulated"),
          ),
        );
        setDeviceOnline(
          devices.some(
            (device) =>
              device.lastSeenAt &&
              Date.now() - new Date(device.lastSeenAt).getTime() < 15000,
          ),
        );
      })
      .catch(() => {});
    call("/api/alerts")
      .then(setAlerts)
      .catch(() => {});
    const s = io(API, { auth: { token: localStorage.getItem("token") } });
    s.on("connect", () => setOnline(true));
    s.on("disconnect", () => setOnline(false));
    s.on("reading", setData);
    s.on("device:status", (status) =>
      setDeviceOnline(status.status === "online"),
    );
    s.on("alert", (a) => setAlerts((v) => [a, ...v].slice(0, 5)));
    return () => s.disconnect();
  }, []);
  const radarSpeed =
    data?.zone === "danger"
      ? "0.7s"
      : data?.zone === "near"
        ? "1.2s"
        : data?.zone === "far"
          ? "2s"
          : "3s";
  const distances = [
    ["Left", data?.left],
    ["Front", data?.front],
    ["Right", data?.right],
  ];
  return (
    <>
      <header>
        <div>
          <p className="eyebrow">CARETAKER DASHBOARD</p>
          <h1>Live overview</h1>
        </div>
        <span className={"status " + (online ? "up" : "down")}>
          {online ? "Dashboard connected" : "Reconnecting"}
        </span>
      </header>
      <section className="cards">
        <motion.div
          className="card radar"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <h2>
            Obstacle distance
            {simulated && <span className="simulated-tag"> · SIMULATED</span>}
          </h2>
          <div
            className="radarview"
            aria-label="Left, front, right sensor distances"
          >
            <div
              className="ring r1"
              style={{ animationDuration: radarSpeed }}
            />
            <div
              className="ring r2"
              style={{ animationDuration: radarSpeed }}
            />
            <div
              className="ring r3"
              style={{ animationDuration: radarSpeed }}
            />
            <div className="device-dot">AID</div>
            {distances.map(([n, d], i) => (
              <div className={"sensor s" + i} key={n}>
                <b>{n}</b>
                <strong>{d == null ? "—" : `${Math.round(d)} cm`}</strong>
              </div>
            ))}
          </div>
          <div className="zonelegend">
            {[
              ["Clear", "#1F7A4D"],
              ["Far", "#F2B01E"],
              ["Near", "#C2410C"],
              ["Danger", "#C92A2A"],
            ].map(([n, c]) => (
              <span key={n}>
                <i style={{ background: c }} />
                {n}
              </span>
            ))}
          </div>
        </motion.div>
        <motion.div
          className="card battery"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08 }}
        >
          <p className="eyebrow">DEVICE BATTERY</p>
          <strong>
            {data?.batteryV ? `${Number(data.batteryV).toFixed(2)} V` : "—"}
          </strong>
          <p>
            {data?.batteryPct != null
              ? `${data.batteryPct}% remaining`
              : "Waiting for device data"}
          </p>
          <span className={"status " + (deviceOnline ? "up" : "down")}>
            {deviceOnline ? "Device online" : "Device offline"}
          </span>
        </motion.div>
        <motion.div
          className="card alertpanel"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
        >
          <h2>Latest alerts</h2>
          <div aria-live="polite">
            {alerts.slice(0, 5).map((a) => (
              <p className="alertrow" key={a._id || a.ts}>
                <b>{a.type?.replace("_", " ")}</b>
                <span>
                  {a.side || "Device"} · {new Date(a.ts).toLocaleTimeString()}
                </span>
              </p>
            ))}
            {!alerts.length && <p className="muted">No recent alerts</p>}
          </div>
        </motion.div>
      </section>
      <p className="note">
        This device assists a white cane and is not a replacement for one. Live
        data can be delayed or unavailable when the device is offline.
      </p>
    </>
  );
}
function History() {
  const [rows, setRows] = useState([]),
    [range, setRange] = useState("24"),
    [cameraAlerts, setCameraAlerts] = useState([]);
  useEffect(() => {
    call(
      `/api/readings?from=${encodeURIComponent(new Date(Date.now() - Number(range) * 3600000).toISOString())}&limit=1000`,
    )
      .then(setRows)
      .catch(() => setRows([]));
  }, [range]);
  useEffect(() => {
    call("/api/alerts?type=camera_obstacle")
      .then(setCameraAlerts)
      .catch(() => setCameraAlerts([]));
  }, []);
  const data = [...rows].reverse().map((r) => ({
    time: new Date(r.ts).toLocaleTimeString(),
    left: r.left,
    front: r.front,
    right: r.right,
  }));
  const danger = rows.reduce((a, r) => {
    const h = new Date(r.ts).toLocaleTimeString([], { hour: "2-digit" });
    a[h] = (a[h] || 0) + (r.zone === "danger" ? 1 : 0);
    return a;
  }, {});
  return (
    <>
      <header>
        <div>
          <p className="eyebrow">DEVICE RECORDS</p>
          <h1>Reading history</h1>
        </div>
        <select
          value={range}
          onChange={(e) => setRange(e.target.value)}
          aria-label="Time range"
        >
          <option value="1">1 hour</option>
          <option value="24">24 hours</option>
          <option value="168">7 days</option>
        </select>
      </header>
      <section className="card chart">
        <h2>Sensor distance (cm)</h2>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={data}>
            <CartesianGrid stroke="#e5e1d8" />
            <XAxis dataKey="time" />
            <YAxis />
            <Tooltip />
            <Line dataKey="left" stroke="#1B4DB1" dot={false} />
            <Line dataKey="front" stroke="#C2410C" dot={false} />
            <Line dataKey="right" stroke="#1F7A4D" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </section>
      <section className="card chart">
        <h2>Danger readings per hour</h2>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart
            data={Object.entries(danger).map(([hour, count]) => ({
              hour,
              count,
            }))}
          >
            <CartesianGrid stroke="#e5e1d8" />
            <XAxis dataKey="hour" />
            <YAxis allowDecimals={false} />
            <Tooltip />
            <Bar dataKey="count" fill="#C92A2A" />
          </BarChart>
        </ResponsiveContainer>
      </section>
      <section className="card chart">
        <h2>Camera Cane obstacle history</h2>
        {cameraAlerts.length ? (
          <div className="stack">
            {cameraAlerts.map((alert) => (
              <p className="alertrow" key={alert._id}>
                <b>{alert.label || "Detected object"}</b>
                <span>
                  {alert.side} ·{" "}
                  {alert.distanceCm == null
                    ? "distance unavailable"
                    : `~${(alert.distanceCm / 100).toFixed(1)} m estimated`}{" "}
                  · {new Date(alert.ts).toLocaleString()}
                </span>
              </p>
            ))}
          </div>
        ) : (
          <p className="muted">
            Camera Cane obstacle alerts will appear here. Distances are
            estimates.
          </p>
        )}
      </section>
    </>
  );
}
function Alerts() {
  const [items, setItems] = useState([]),
    [type, setType] = useState("");
  async function load() {
    setItems(await call("/api/alerts" + (type ? `?type=${type}` : "")));
  }
  useEffect(() => {
    load().catch(() => {});
  }, [type]);
  async function ack(id) {
    await call(`/api/alerts/${id}/ack`, { method: "PATCH" });
    load();
  }
  return (
    <>
      <header>
        <div>
          <p className="eyebrow">CARETAKER INBOX</p>
          <h1>Alerts</h1>
        </div>
        <select
          aria-label="Filter alerts"
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          <option value="">All types</option>
          {[
            "danger",
            "low_battery",
            "sos",
            "sensor_fault",
            "camera_obstacle",
          ].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </header>
      <div className="stack">
        {items.map((a) => (
          <article className="card alertitem" key={a._id}>
            <div>
              <b>{a.type.replaceAll("_", " ")}</b>
              <p>
                {a.deviceId} · {a.side || "No side"}{" "}
                {a.distanceCm != null ? `· ${a.distanceCm} cm` : ""}
                {a.label ? ` · ${a.label}` : ""}
              </p>
              <small>{new Date(a.ts).toLocaleString()}</small>
            </div>
            {a.acknowledged ? (
              <span className="status">Acknowledged</span>
            ) : (
              <button onClick={() => ack(a._id)}>Acknowledge</button>
            )}
          </article>
        ))}
        {!items.length && <p className="muted">No alerts match this filter.</p>}
      </div>
    </>
  );
}
function Settings() {
  const [devices, setDevices] = useState([]),
    [msg, setMsg] = useState("");
  useEffect(() => {
    call("/api/devices")
      .then(setDevices)
      .catch(() => {});
  }, []);
  async function save(e, d) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await call(`/api/devices/${d._id}/config`, {
        method: "PATCH",
        body: JSON.stringify({
          intensity: Number(f.get("intensity")),
          thresholds: {
            danger: Number(f.get("danger")),
            near: Number(f.get("near")),
            clear: Number(f.get("clear")),
          },
          buzzer: f.get("buzzer") === "on",
          sensorsEnabled: {
            left: f.get("left") === "on",
            front: f.get("front") === "on",
            right: f.get("right") === "on",
          },
        }),
      });
      setMsg(
        "Settings saved. The device will fetch them within about a minute.",
      );
    } catch (x) {
      setMsg(x.message);
    }
  }
  return (
    <>
      <header>
        <div>
          <p className="eyebrow">DEVICE CONTROL</p>
          <h1>Device settings</h1>
        </div>
      </header>
      {devices.map((d) => (
        <form
          className="card settings"
          key={d._id}
          onSubmit={(e) => save(e, d)}
        >
          <h2>{d.name}</h2>
          <div className="fields">
            {[
              ["danger", "Danger boundary (cm)", d.config.thresholds.danger],
              ["near", "Near boundary (cm)", d.config.thresholds.near],
              ["clear", "Clear boundary (cm)", d.config.thresholds.clear],
              ["intensity", "Motor intensity (%)", d.config.intensity],
            ].map(([name, label, val]) => (
              <label key={name}>
                {label}
                <input
                  name={name}
                  type="number"
                  defaultValue={val}
                  min="0"
                  max="400"
                />
              </label>
            ))}
          </div>
          <div className="checks">
            {["left", "front", "right", "buzzer"].map((n) => (
              <label key={n}>
                <input
                  type="checkbox"
                  name={n}
                  defaultChecked={
                    n === "buzzer"
                      ? d.config.buzzer
                      : d.config.sensorsEnabled[n]
                  }
                />
                {n}
              </label>
            ))}
          </div>
          <button>Save settings</button>
          {msg && <p role="status">{msg}</p>}
        </form>
      ))}
      {!devices.length && <p className="muted">No assigned devices.</p>}
    </>
  );
}
function Demo() {
  const [message, setMessage] = useState(
    "Simulated records are clearly labelled and are not sensor measurements.",
  );
  async function act(action) {
    try {
      const r = await call(`/api/demo/${action}`, { method: "POST" });
      setMessage(
        r.running
          ? "Simulation running. Records are simulated."
          : "Simulation stopped.",
      );
    } catch (e) {
      setMessage(e.message);
    }
  }
  return (
    <>
      <header>
        <div>
          <p className="eyebrow">VIVA TOOL</p>
          <h1>Device simulator</h1>
        </div>
      </header>
      <section className="card settings">
        <p>
          Generate simulated device readings when physical hardware is
          unavailable.
        </p>
        <div className="actions">
          <button onClick={() => act("start")}>Start simulation</button>
          <button className="secondary" onClick={() => act("stop")}>
            Stop simulation
          </button>
        </div>
        <p role="status">{message}</p>
      </section>
    </>
  );
}
export default function App() {
  const user = JSON.parse(localStorage.getItem("user") || "null");
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="*"
        element={
          <Protected>
            <Shell>
              <AnimatePresence mode="wait">
                <Routes>
                  <Route path="/" element={<CameraCane />} />
                  <Route path="/hardware" element={<Live />} />
                  <Route path="/history" element={<History />} />
                  <Route path="/alerts" element={<Alerts />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route
                    path="/demo"
                    element={
                      <Protected admin>
                        <Demo />
                      </Protected>
                    }
                  />
                  <Route path="*" element={<Navigate to="/" />} />
                </Routes>
              </AnimatePresence>
            </Shell>
          </Protected>
        }
      />
    </Routes>
  );
}
