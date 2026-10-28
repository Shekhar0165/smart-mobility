import React, { useCallback, useEffect, useRef, useState } from "react";
import { FilesetResolver, ObjectDetector } from "@mediapipe/tasks-vision";
import * as ort from "onnxruntime-web/wasm";
import ortWasmModuleUrl from "./ort/ort-wasm-simd-threaded.mjs?url";
import { NavLink } from "react-router-dom";
import {
  beepIntervalMs,
  calculateFocalLengthPx,
  estimateDistanceM,
  getTypicalHeight,
  initialFocalLengthPx,
  median,
  sideForBox,
  zoneForDistance,
} from "./cameraMath.js";
import {
  decodeYoloOutput,
  distanceFeatures,
  letterboxFrame,
} from "./yoloRuntime.js";
import "./camera.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:4000";
const MODEL_URL = "/models/efficientdet_lite0.tflite";
const YOLO_MODEL_URL = "/models/yolov8n_kitti.onnx";
const DISTANCE_MODEL_URL = "/models/distance_model.onnx";
const WASM_URL = "/mediapipe";
const STORAGE_KEY = "camera-cane-focal-length-px";
ort.env.wasm.wasmPaths = {
  mjs: ortWasmModuleUrl,
  wasm: "/ort/ort-wasm-simd-threaded.wasm",
};
ort.env.wasm.numThreads = 1;

function drawOverlay(canvas, video, objects) {
  if (!canvas || !video) return;
  const width = video.videoWidth || 0;
  const height = video.videoHeight || 0;
  if (!width || !height) return;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  for (const object of objects) {
    const { x, y, w, h } = object.box;
    ctx.strokeStyle = object.color;
    ctx.lineWidth = Math.max(3, width / 300);
    ctx.strokeRect(x, y, w, h);
    const caption = `${object.label} · ${object.distanceM == null ? "distance unavailable" : `~${object.distanceM.toFixed(1)} m`} (estimated)`;
    ctx.font = `bold ${Math.max(15, width / 55)}px Arial`;
    const textWidth = ctx.measureText(caption).width;
    const labelY = Math.max(0, y - Math.max(29, width / 35));
    ctx.fillStyle = object.color;
    ctx.fillRect(x, labelY, textWidth + 16, Math.max(29, width / 35));
    ctx.fillStyle = "#ffffff";
    ctx.fillText(caption, x + 8, labelY + Math.max(20, width / 60));
  }
}

class LocalBeeper {
  constructor(context) {
    this.context = context;
    this.oscillator = context.createOscillator();
    this.gain = context.createGain();
    this.panner = context.createStereoPanner();
    this.gain.gain.value = 0;
    this.oscillator.frequency.value = 760;
    this.oscillator.connect(this.gain);
    this.gain.connect(this.panner);
    this.panner.connect(context.destination);
    this.oscillator.start();
    this.mode = null;
    this.interval = 900;
    this.timer = null;
    this.volume = 0.6;
  }

  setGain(value) {
    const now = this.context.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setTargetAtTime(value, now, 0.012);
  }

  pulse() {
    const now = this.context.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.volume, now);
    this.gain.gain.setValueAtTime(0, now + 0.11);
  }

  nextPulse = () => {
    if (this.mode !== "pulse") return;
    this.pulse();
    this.timer = window.setTimeout(this.nextPulse, this.interval);
  };

  setTarget(distanceM, side, alertDistanceM, volume, muted) {
    this.volume = muted ? 0 : volume;
    this.panner.pan.setTargetAtTime(
      side === "left" ? -1 : side === "right" ? 1 : 0,
      this.context.currentTime,
      0.03,
    );
    const interval = beepIntervalMs(distanceM, alertDistanceM);
    if (interval == null) {
      this.clear();
      return;
    }
    this.interval = Math.max(120, interval);
    if (interval === 0) {
      if (this.timer) window.clearTimeout(this.timer);
      this.timer = null;
      this.mode = "continuous";
      this.setGain(this.volume);
      return;
    }
    if (this.mode === "continuous") this.setGain(0);
    if (this.mode !== "pulse") {
      this.mode = "pulse";
      this.pulse();
      this.timer = window.setTimeout(this.nextPulse, this.interval);
    }
  }

  clear() {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = null;
    this.mode = null;
    this.setGain(0);
  }

  close() {
    this.clear();
    this.oscillator.stop();
    this.context.close();
  }
}

const zoneColor = {
  clear: "#1F7A4D",
  far: "#F2B01E",
  near: "#C2410C",
  danger: "#C92A2A",
};

function ModeSwitch() {
  return (
    <nav className="camera-mode-switch" aria-label="Operating mode">
      <NavLink to="/" end>
        Camera mode
      </NavLink>
      <NavLink to="/hardware">Hardware mode (ESP32)</NavLink>
    </nav>
  );
}

function makeJpegFrame(video) {
  if (!video?.videoWidth || !video?.videoHeight) return null;
  const scale = Math.min(1, 640 / video.videoWidth, 640 / video.videoHeight);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.7);
}

export default function CameraCane() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const inputCanvasRef = useRef(document.createElement("canvas"));
  const streamRef = useRef(null);
  const detectorRef = useRef(null);
  const runtimeRef = useRef({ yolo: null, distance: null });
  const rafRef = useRef(null);
  const beeperRef = useRef(null);
  const historyRef = useRef(new Map());
  const lastAlertRef = useRef(new Map());
  const lastFrameTimeRef = useRef(0);
  const fpsCountRef = useRef(0);
  const fpsStartRef = useRef(0);
  const latestObjectsRef = useRef([]);
  const settingsRef = useRef({});
  const descriptionBusyRef = useRef(false);
  const describeNowRef = useRef(null);
  const focalLengthRef = useRef(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState(
    "Camera is stopped. Start to begin local detection.",
  );
  const [objects, setObjects] = useState([]);
  // const [modelMode, setModelMode] = useState(() =>
  //   localStorage.getItem("camera-cane-model-mode") === "old" ? "old" : "new",
  // );
  const [modelMode, setModelMode] = useState("old");
  const [alertDistance, setAlertDistance] = useState(2);
  const [volume, setVolume] = useState(0.6);
  const [muted, setMuted] = useState(false);
  const [sensitivity, setSensitivity] = useState(0.45);
  const [calibrationClass, setCalibrationClass] = useState("person");
  const [knownDistance, setKnownDistance] = useState(2);
  const [focalLength, setFocalLength] = useState(() => {
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : null;
  });
  const [calibrationMessage, setCalibrationMessage] = useState(
    "Calibration is optional; distance values are estimates.",
  );
  const [geminiInterval, setGeminiInterval] = useState(4);
  const [speakDescriptions, setSpeakDescriptions] = useState(false);
  const [language, setLanguage] = useState("en");
  const [description, setDescription] = useState(null);
  const [descriptionNotice, setDescriptionNotice] = useState("");
  const [fps, setFps] = useState(null);
  const [soundDelay, setSoundDelay] = useState(null);

  settingsRef.current = { alertDistance, volume, muted, modelMode };
  focalLengthRef.current = focalLength;

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    detectorRef.current?.close();
    detectorRef.current = null;
    runtimeRef.current.yolo?.release();
    runtimeRef.current.distance?.release();
    runtimeRef.current = { yolo: null, distance: null };
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (beeperRef.current) {
      beeperRef.current.close();
      beeperRef.current = null;
    }
    setObjects([]);
    setFps(null);
    setSoundDelay(null);
    setRunning(false);
    setStatus("Camera is stopped.");
  }, []);

  useEffect(() => () => stop(), [stop]);

  const speakScene = useCallback(
    (scene) => {
      if (!speakDescriptions || !("speechSynthesis" in window)) return;
      window.speechSynthesis.cancel();
      const obstacleText = scene.objects
        .slice(0, 3)
        .map(
          (item) =>
            `${item.label}, ${item.side}, about ${Number(item.estimatedDistanceM).toFixed(1)} metres estimated`,
        )
        .join(". ");
      const utterance = new SpeechSynthesisUtterance(
        [scene.description, obstacleText, scene.advice]
          .filter(Boolean)
          .join(". "),
      );
      utterance.lang = language === "hi" ? "hi-IN" : "en-US";
      window.speechSynthesis.speak(utterance);
    },
    [language, speakDescriptions],
  );

  const describeSurroundings = useCallback(async () => {
    if (descriptionBusyRef.current) return;
    const frame = makeJpegFrame(videoRef.current);
    if (!frame) {
      setDescriptionNotice("Start the camera before describing surroundings.");
      return;
    }
    descriptionBusyRef.current = true;
    setDescriptionNotice("Requesting an advisory scene description…");
    try {
      const response = await fetch(`${API}/api/vision/describe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("token") || ""}`,
        },
        body: JSON.stringify({ image: frame }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Description unavailable.");
      setDescription(data);
      setDescriptionNotice(
        data.mode === "mock"
          ? "Mock response: add GEMINI_API_KEY on the backend for real scene descriptions. Local beeps do not use Gemini."
          : "Scene description is advisory; obstacle beeps remain local.",
      );
      speakScene(data);
    } catch (error) {
      setDescriptionNotice(
        `${error.message || "Gemini is unavailable."} Local camera beeping continues without internet.`,
      );
    } finally {
      descriptionBusyRef.current = false;
    }
  }, [speakScene]);

  describeNowRef.current = describeSurroundings;

  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(
      () => describeNowRef.current?.(),
      geminiInterval * 1000,
    );
    return () => window.clearInterval(timer);
  }, [geminiInterval, running]);

  useEffect(() => {
    if (!speakDescriptions && "speechSynthesis" in window)
      window.speechSynthesis.cancel();
  }, [speakDescriptions]);

  const runDetectorFrame = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !detectorRef.current || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(runDetectorFrame);
      return;
    }
    const startedAt = performance.now();
    if (video.currentTime !== lastFrameTimeRef.current) {
      lastFrameTimeRef.current = video.currentTime;
      const width = video.videoWidth;
      const height = video.videoHeight;
      const effectiveFocalLength =
        focalLengthRef.current || initialFocalLengthPx(width);
      const currentSettings = settingsRef.current;
      let detections;
      let learnedDistances = [];
      if (currentSettings.modelMode === "new") {
        const session = runtimeRef.current.yolo;
        const distanceSession = runtimeRef.current.distance;
        if (!session || !distanceSession) {
          rafRef.current = requestAnimationFrame(runDetectorFrame);
          return;
        }
        const letterboxed = letterboxFrame(video, inputCanvasRef.current);
        const inputTensor = new ort.Tensor(
          "float32",
          letterboxed.input,
          [1, 3, 640, 640],
        );
        const modelOutput = await session.run({
          [session.inputNames[0]]: inputTensor,
        });
        detections = decodeYoloOutput(
          modelOutput[session.outputNames[0]].data,
          letterboxed,
          0.4,
          0.5,
        );
        const featureRows = detections
          .map((detection, index) => {
            const features = distanceFeatures(detection, width, height);
            if (features) learnedDistances.push(index);
            return features;
          })
          .filter(Boolean);
        if (featureRows.length) {
          const flatFeatures = Float32Array.from(featureRows.flat());
          const featureTensor = new ort.Tensor("float32", flatFeatures, [
            featureRows.length,
            6,
          ]);
          const distanceOutput = await distanceSession.run({
            [distanceSession.inputNames[0]]: featureTensor,
          });
          const predictions =
            distanceOutput[distanceSession.outputNames[0]].data;
          learnedDistances = Array.from(
            learnedDistances,
            (detectionIndex, rowIndex) => [
              detectionIndex,
              Number(predictions[rowIndex]),
            ],
          );
        } else {
          learnedDistances = [];
        }
      } else {
        const result = detectorRef.current.detectForVideo(video, startedAt);
        detections = (result.detections || []).map((detection) => {
          const category = detection.categories?.[0];
          const box = detection.boundingBox;
          return {
            label: category?.categoryName || "object",
            score: category?.score || 0,
            box: {
              x: box.originX,
              y: box.originY,
              w: box.width,
              h: box.height,
            },
          };
        });
      }
      const learnedDistanceByIndex = new Map(learnedDistances);
      const frameObjects = detections.map((detection, index) => {
        const { label, score, box } = detection;
        const side = sideForBox(box.x + box.w / 2, width);
        const rawDistance =
          currentSettings.modelMode === "new" &&
          learnedDistanceByIndex.has(index)
            ? learnedDistanceByIndex.get(index)
            : estimateDistanceM(
                getTypicalHeight(label) ??
                  (label === "person_sitting"
                    ? 1.2
                    : label === "misc"
                      ? 0.8
                      : null),
                effectiveFocalLength,
                box.h,
              );
        let distanceM = null;
        if (Number.isFinite(rawDistance) && rawDistance > 0) {
          const historyKey = `${label}:${side}`;
          const values = historyRef.current.get(historyKey) || [];
          values.push(rawDistance);
          if (values.length > 5) values.shift();
          historyRef.current.set(historyKey, values);
          distanceM = median(values);
        }
        const zone =
          distanceM == null
            ? "clear"
            : zoneForDistance(distanceM, currentSettings.alertDistance);
        return {
          label,
          score,
          side,
          distanceM,
          zone,
          color: zoneColor[zone],
          box: {
            x: box.x,
            y: box.y,
            w: box.w,
            h: box.h,
          },
        };
      });
      latestObjectsRef.current = frameObjects;
      drawOverlay(canvasRef.current, video, frameObjects);
      setObjects(frameObjects);

      const nearest = frameObjects
        .filter(
          (object) =>
            object.distanceM != null &&
            object.distanceM <= currentSettings.alertDistance,
        )
        .sort((a, b) => a.distanceM - b.distanceM)[0];
      if (nearest && beeperRef.current) {
        beeperRef.current.setTarget(
          nearest.distanceM,
          nearest.side,
          currentSettings.alertDistance,
          currentSettings.volume,
          currentSettings.muted,
        );
        setSoundDelay(Math.round(performance.now() - startedAt));
      } else {
        beeperRef.current?.clear();
      }

      const alertNow = performance.now();
      for (const object of frameObjects) {
        if (
          object.distanceM == null ||
          object.distanceM > currentSettings.alertDistance
        )
          continue;
        const previous = lastAlertRef.current.get(object.label) || 0;
        if (alertNow - previous < 2000) continue;
        lastAlertRef.current.set(object.label, alertNow);
        fetch(`${API}/api/alerts/camera`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${localStorage.getItem("token") || ""}`,
          },
          body: JSON.stringify({
            side: object.side,
            distanceCm: Math.min(2000, Math.round(object.distanceM * 100)),
            label: object.label,
            source: "laptop-camera",
          }),
        }).catch(() => {});
      }

      fpsCountRef.current += 1;
      if (!fpsStartRef.current) fpsStartRef.current = startedAt;
      if (startedAt - fpsStartRef.current >= 1000) {
        setFps(
          Math.round(
            (fpsCountRef.current * 1000) / (startedAt - fpsStartRef.current),
          ),
        );
        fpsCountRef.current = 0;
        fpsStartRef.current = startedAt;
      }
    }
    rafRef.current = requestAnimationFrame(runDetectorFrame);
  }, []);

  const start = async () => {
    if (running) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus(
        "Camera access is unavailable here. Use localhost or a secure browser connection.",
      );
      return;
    }
    setStatus("Starting local detector and camera…");
    try {
      const AudioContextClass =
        window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        const context = new AudioContextClass();
        await context.resume();
        beeperRef.current = new LocalBeeper(context);
      }
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
        audio: false,
      });
      streamRef.current = mediaStream;
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        await videoRef.current.play();
      }
      const [vision, yoloSession, distanceSession] = await Promise.all([
        FilesetResolver.forVisionTasks(WASM_URL),
        ort.InferenceSession.create(YOLO_MODEL_URL, {
          executionProviders: ["wasm"],
        }),
        ort.InferenceSession.create(DISTANCE_MODEL_URL, {
          executionProviders: ["wasm"],
        }),
      ]);
      runtimeRef.current = { yolo: yoloSession, distance: distanceSession };
      let detector;
      try {
        detector = await ObjectDetector.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
          runningMode: "VIDEO",
          scoreThreshold: sensitivity,
          maxResults: 10,
        });
      } catch {
        detector = await ObjectDetector.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
          runningMode: "VIDEO",
          scoreThreshold: sensitivity,
          maxResults: 10,
        });
      }
      detectorRef.current = detector;
      runtimeRef.current = { yolo: yoloSession, distance: distanceSession };
      historyRef.current.clear();
      lastAlertRef.current.clear();
      lastFrameTimeRef.current = 0;
      fpsCountRef.current = 0;
      fpsStartRef.current = 0;
      setRunning(true);
      setStatus(
        "Camera running. New and Old model sets are loaded; distances are estimates and alerts stay local.",
      );
      rafRef.current = requestAnimationFrame(runDetectorFrame);
    } catch (error) {
      detectorRef.current?.close();
      detectorRef.current = null;
      runtimeRef.current.yolo?.release();
      runtimeRef.current.distance?.release();
      runtimeRef.current = { yolo: null, distance: null };
      beeperRef.current?.close();
      beeperRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setStatus(
        `Could not start camera detection: ${error.message || "check camera permission and local model files"}`,
      );
    }
  };

  const calibrate = () => {
    const current = latestObjectsRef.current.find(
      (object) => object.label.toLowerCase() === calibrationClass.toLowerCase(),
    );
    const realHeight = getTypicalHeight(calibrationClass);
    if (!current || !realHeight) {
      setCalibrationMessage(
        `No ${calibrationClass} is currently detected. Keep it visible and try again.`,
      );
      return;
    }
    const calculated = calculateFocalLengthPx(
      realHeight,
      Number(knownDistance),
      current.box.h,
    );
    if (!calculated) {
      setCalibrationMessage(
        "Calibration needs a valid object height and known distance.",
      );
      return;
    }
    localStorage.setItem(STORAGE_KEY, String(calculated));
    setFocalLength(calculated);
    historyRef.current.clear();
    setCalibrationMessage(
      `Calibration saved using ${calibrationClass} at ${Number(knownDistance).toFixed(1)} m. New distances remain estimates.`,
    );
  };

  const updateAlertDistance = (value) => {
    const nextValue = Number(value);
    setAlertDistance(nextValue);
    localStorage.setItem("camera-cane-alert-distance-m", String(nextValue));
  };

  const updateModelMode = (value) => {
    setModelMode(value);
    localStorage.setItem("camera-cane-model-mode", value);
    historyRef.current.clear();
    latestObjectsRef.current = [];
    setObjects([]);
  };

  useEffect(() => {
    const saved = Number(localStorage.getItem("camera-cane-alert-distance-m"));
    if (Number.isFinite(saved) && saved >= 0.5 && saved <= 20)
      setAlertDistance(saved);
  }, []);

  const nearest = objects
    .filter((object) => object.distanceM != null)
    .sort((a, b) => a.distanceM - b.distanceM)[0];
  const alerting = nearest && nearest.distanceM <= alertDistance;

  return (
    <div className="camera-cane">
      <header>
        <div>
          <p className="eyebrow">PRIMARY DEMO · CAMERA CANE</p>
          <h1>Camera Cane</h1>
          <p className="camera-subtitle">
            Local webcam detection with estimated obstacle distances and
            directional sound.
          </p>
        </div>
        <span className={`status ${running ? "up" : "down"}`}>
          {running ? "Local detector active" : "Detector stopped"}
        </span>
      </header>

      <ModeSwitch />

      <section
        className={`camera-status-banner ${alerting ? `zone-${nearest.zone}` : "zone-clear"}`}
        aria-live="assertive"
        aria-atomic="true"
      >
        <strong>
          {alerting
            ? `OBJECT AT ~${nearest.distanceM.toFixed(1)} m, ${nearest.side.toUpperCase()}`
            : "CLEAR"}
        </strong>
        <span>
          {alerting
            ? "Distance is estimated. Follow your usual mobility practices."
            : "No supported object is detected inside range; this does not confirm the path is clear."}
        </span>
      </section>

      <div className="camera-layout">
        <section className="camera-preview-card card">
          <div className="camera-video-wrap">
            <video
              ref={videoRef}
              className="camera-video"
              muted
              playsInline
              aria-label="Live webcam view"
            />
            <canvas
              ref={canvasRef}
              className="camera-overlay"
              aria-hidden="true"
            />
            {!running && (
              <div className="camera-placeholder">
                Camera preview will appear here
              </div>
            )}
          </div>
          <p className="camera-live-status" role="status" aria-live="polite">
            {status}
          </p>
          <div className="camera-actions">
            {running ? (
              <button className="secondary" onClick={stop}>
                Stop camera
              </button>
            ) : (
              <button onClick={start}>Start camera + sound</button>
            )}
            <button
              className="secondary"
              onClick={describeSurroundings}
              disabled={!running}
            >
              Describe surroundings
            </button>
          </div>
          <p className="camera-safety-note">
            Estimated distances can be wrong. This prototype assists a white
            cane and does not replace it.
          </p>
        </section>

        <section className="card camera-controls">
          <h2>Camera and alert controls</h2>
          <label className="camera-control">
            <span>Detection and distance models</span>
            <select
              aria-label="Detection and distance models"
              value={modelMode}
              onChange={(event) => updateModelMode(event.target.value)}
            >
              <option value="new">New — YOLOv8 + learned distance</option>
              {/* <option value="old">Old — EfficientDet + pinhole distance</option> */}
            </select>
          </label>
          <label className="camera-control">
            <span>
              Alert distance <b>{alertDistance.toFixed(1)} m</b>
            </span>
            <input
              aria-label="Alert distance"
              type="range"
              min="0.5"
              max="20"
              step="0.1"
              value={alertDistance}
              onChange={(event) => updateAlertDistance(event.target.value)}
            />
          </label>
          <label className="camera-control">
            <span>
              Sound volume <b>{Math.round(volume * 100)}%</b>
            </span>
            <input
              aria-label="Sound volume"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={volume}
              onChange={(event) => setVolume(Number(event.target.value))}
            />
          </label>
          <label className="camera-inline-control">
            <input
              type="checkbox"
              checked={muted}
              onChange={(event) => setMuted(event.target.checked)}
            />
            Mute sound
          </label>
          <label className="camera-control">
            <span>
              Detector confidence{" "}
              <b>
                {modelMode === "new"
                  ? "40%"
                  : `${Math.round(sensitivity * 100)}%`}
              </b>
            </span>
            <input
              aria-label="Detector sensitivity"
              type="range"
              min="0.1"
              max="0.9"
              step="0.05"
              value={sensitivity}
              disabled={modelMode === "new"}
              onChange={(event) => setSensitivity(Number(event.target.value))}
            />
            <small>
              {modelMode === "new"
                ? "YOLO uses the trained model with a fixed 0.4 confidence threshold."
                : "Applies to EfficientDet the next time the camera starts."}
            </small>
          </label>

          <div hidden={modelMode === "new"}>
            <h2>Distance calibration</h2>
            <p className="muted">
              Show one supported object at a measured distance, then save a
              camera focal-length estimate.
            </p>
            <div className="camera-calibration-fields">
              <label>
                Object class
                <select
                  value={calibrationClass}
                  onChange={(event) => setCalibrationClass(event.target.value)}
                >
                  {Object.keys({
                    person: 1,
                    chair: 1,
                    bottle: 1,
                    laptop: 1,
                    door: 1,
                    car: 1,
                    backpack: 1,
                  }).map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              </label>
              <label>
                Known distance (m)
                <input
                  type="number"
                  min="0.2"
                  max="20"
                  step="0.1"
                  value={knownDistance}
                  onChange={(event) => setKnownDistance(event.target.value)}
                />
              </label>
            </div>
            <button
              className="secondary"
              onClick={calibrate}
              disabled={!running}
            >
              Calibrate
            </button>
            <p className="camera-feedback" role="status">
              {calibrationMessage}
            </p>
            <small>
              {focalLength
                ? "Saved calibration is active."
                : "Using a nominal webcam field-of-view starting estimate until calibrated."}
            </small>
          </div>

          <h2>Scene description (Gemini advisory)</h2>
          <p className="muted">
            When a Gemini key is configured, the browser sends a downscaled JPEG
            frame to the backend on this interval and when you request a
            description. Without a key, the response is a labelled mock. Local
            obstacle beeps do not use these frames.
          </p>
          <label className="camera-control">
            <span>
              Automatic description interval <b>{geminiInterval} s</b>
            </span>
            <input
              aria-label="Gemini interval"
              type="range"
              min="4"
              max="30"
              step="1"
              value={geminiInterval}
              onChange={(event) =>
                setGeminiInterval(Number(event.target.value))
              }
            />
          </label>
          <label className="camera-inline-control">
            <input
              type="checkbox"
              checked={speakDescriptions}
              onChange={(event) => setSpeakDescriptions(event.target.checked)}
            />
            Speak descriptions
          </label>
          <label className="camera-control">
            <span>Speech language</span>
            <select
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
            >
              <option value="en">English</option>
              <option value="hi">Hindi</option>
            </select>
          </label>
          <p className="camera-feedback" role="status" aria-live="polite">
            {descriptionNotice}
          </p>
          {description && (
            <div className="scene-description">
              <b>
                {description.mode === "mock"
                  ? "Mock scene description"
                  : "Advisory description"}
              </b>
              <p>{description.description}</p>
              {description.objects?.map((item, index) => (
                <p key={`${item.label}-${index}`}>
                  {item.label} · {item.side} · ~
                  {Number(item.estimatedDistanceM).toFixed(1)} m (estimated) ·{" "}
                  {item.risk} risk
                </p>
              ))}
              <p>{description.advice}</p>
            </div>
          )}
        </section>
      </div>

      <section
        className="card camera-metrics"
        aria-label="Measured runtime metrics"
      >
        <div>
          <span>Detector FPS</span>
          <strong>{running && fps != null ? fps : "—"}</strong>
          <small>Measured in this browser session</small>
        </div>
        <div>
          <span>Detection → sound scheduling</span>
          <strong>{soundDelay == null ? "—" : `${soundDelay} ms`}</strong>
          <small>
            Measured with performance.now(); not speaker-output latency
          </small>
        </div>
        <div>
          <span>Visible detections</span>
          <strong>{objects.length}</strong>
          <small>Current camera frame</small>
        </div>
      </section>

      <section className="card camera-object-list">
        <h2>Detected objects</h2>
        {objects.length ? (
          <ul>
            {objects.map((object, index) => (
              <li key={`${object.label}-${object.side}-${index}`}>
                <span
                  className="zone-chip"
                  style={{ backgroundColor: object.color }}
                >
                  {object.zone.toUpperCase()}
                </span>
                <b>{object.label}</b>
                <span>{object.side}</span>
                <span>
                  {object.distanceM == null
                    ? "Distance unavailable (estimated)"
                    : `~${object.distanceM.toFixed(1)} m (estimated)`}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No supported objects are currently detected.</p>
        )}
      </section>
    </div>
  );
}
