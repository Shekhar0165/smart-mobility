#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <stdint.h>
#include <time.h>
#include "config.h"

// All obstacle sensing and haptic decisions run locally, even without Wi-Fi.
constexpr int sensorCount = 3;
const int trigPins[sensorCount] = {13, 25, 27};
const int echoPins[sensorCount] = {14, 26, 33};
const int motorPins[sensorCount] = {18, 19, 21};
const char *sides[sensorCount] = {"left", "front", "right"};
constexpr int buzzerPin = 23, sosPin = 32, batteryPin = 35, ledPin = 2;
constexpr unsigned long echoTimeoutUs = 12000, sensorGapUs = 8000;

struct BufferedReading {
  float left, front, right, battery;
  const char *zone;
  char timestamp[25];
};
BufferedReading queue[60];
int queueStart = 0, queueCount = 0;
float history[sensorCount][3] = {{-1, -1, -1}, {-1, -1, -1}, {-1, -1, -1}};
float distances[sensorCount] = {-1, -1, -1};
int zones[sensorCount] = {0, 0, 0}, historyAt = 0, consecutiveFaultCycles = 0;
bool sensorEnabled[sensorCount] = {true, true, true}, buzzerEnabled = false;
bool pendingDanger[sensorCount] = {false, false, false};
bool pendingFault = false, faultReported = false, lowBatterySent = false;
volatile uint32_t echoRiseUs[sensorCount] = {0, 0, 0};
volatile uint32_t echoDurationUs[sensorCount] = {0, 0, 0};
volatile bool echoComplete[sensorCount] = {false, false, false};
int scanIndex = -1;
bool waitingForGap = false, cycleHadEcho = false;
uint32_t scanStartedUs = 0, nextTriggerUs = 0;
unsigned long lastCycle = 0, lastPost = 0, lastConfig = 0, sosStarted = 0;
bool sosSent = false;
int clearCm = 200, nearCm = 100, dangerCm = 50, intensity = 70;

void IRAM_ATTR onEchoEdge(void *context) {
  const int index = static_cast<int>(reinterpret_cast<intptr_t>(context));
  const uint32_t nowUs = micros();
  if (digitalRead(echoPins[index]) == HIGH) {
    echoRiseUs[index] = nowUs;
  } else if (echoRiseUs[index] != 0) {
    echoDurationUs[index] = nowUs - echoRiseUs[index];
    echoRiseUs[index] = 0;
    echoComplete[index] = true;
  }
}

int median3(float a, float b, float c) {
  if (a > b) { float t = a; a = b; b = t; }
  if (b > c) { float t = b; b = c; c = t; }
  if (a > b) b = a;
  return static_cast<int>(b);
}

int classifyDistance(float cm, int previousZone) {
  if (cm < 0) return 0;
  int next = cm < dangerCm ? 3 : cm < nearCm ? 2 : cm < clearCm ? 1 : 0;
  if (previousZone == 3 && cm < dangerCm + 5) return 3;
  if (previousZone == 2 && cm >= dangerCm - 5 && cm < nearCm + 5) return 2;
  if (previousZone == 1 && cm >= nearCm - 5 && cm < clearCm + 5) return 1;
  return next;
}

bool postJson(const char *path, JsonDocument &body) {
  if (WiFi.status() != WL_CONNECTED) return false;
  HTTPClient http;
  http.setConnectTimeout(100);
  http.setTimeout(100);
  if (!http.begin(String(SERVER_URL) + path)) return false;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", DEVICE_API_KEY);
  String encoded;
  serializeJson(body, encoded);
  const int status = http.POST(encoded);
  http.end();
  return status >= 200 && status < 300;
}

void sendAlert(const char *type, int sensor = -1, float cm = -1) {
  StaticJsonDocument<160> body;
  body["type"] = type;
  if (sensor >= 0) {
    body["side"] = sides[sensor];
    if (cm >= 0) body["distanceCm"] = cm;
  }
  postJson("/api/alerts", body);
}

void refreshConfig() {
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient http;
  http.setConnectTimeout(100);
  http.setTimeout(100);
  if (!http.begin(String(SERVER_URL) + "/api/devices/me/config")) return;
  http.addHeader("x-api-key", DEVICE_API_KEY);
  if (http.GET() == 200) {
    StaticJsonDocument<512> body;
    if (!deserializeJson(body, http.getString())) {
      JsonObject config = body["config"];
      clearCm = config["thresholds"]["clear"] | 200;
      nearCm = config["thresholds"]["near"] | 100;
      dangerCm = config["thresholds"]["danger"] | 50;
      intensity = config["intensity"] | 70;
      JsonObject enabled = config["sensorsEnabled"];
      sensorEnabled[0] = enabled["left"] | true;
      sensorEnabled[1] = enabled["front"] | true;
      sensorEnabled[2] = enabled["right"] | true;
      buzzerEnabled = config["buzzer"] | false;
    }
  }
  http.end();
}

void triggerSensor(int index) {
  noInterrupts();
  echoRiseUs[index] = 0;
  echoDurationUs[index] = 0;
  echoComplete[index] = false;
  interrupts();
  digitalWrite(trigPins[index], LOW);
  delayMicroseconds(2);
  digitalWrite(trigPins[index], HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPins[index], LOW);
  scanStartedUs = micros();
}

void finishSensor(int index, float cm, unsigned long nowMs) {
  if (!sensorEnabled[index]) {
    history[index][0] = history[index][1] = history[index][2] = -1;
    distances[index] = -1;
    zones[index] = 0;
    pendingDanger[index] = false;
    return;
  }
  history[index][historyAt] = cm;
  if (cm >= 0) cycleHadEcho = true;
  distances[index] = median3(history[index][0], history[index][1], history[index][2]);
  const int oldZone = zones[index];
  zones[index] = classifyDistance(distances[index], oldZone);
  if (zones[index] == 3 && oldZone != 3) pendingDanger[index] = true;
  (void)nowMs;
}

void completeSensorCycle(unsigned long nowMs) {
  historyAt = (historyAt + 1) % 3;
  bool dangerPresent = false, anyEnabled = false;
  for (int i = 0; i < sensorCount; i++) {
    if (sensorEnabled[i]) anyEnabled = true;
    if (zones[i] == 3) dangerPresent = true;
  }
  if (!anyEnabled) {
    consecutiveFaultCycles = 0;
    faultReported = false;
    digitalWrite(ledPin, HIGH);
    scanIndex = -1;
    waitingForGap = false;
    return;
  }
  digitalWrite(buzzerPin, buzzerEnabled && dangerPresent ? HIGH : LOW);

  if (cycleHadEcho) {
    consecutiveFaultCycles = 0;
    faultReported = false;
    digitalWrite(ledPin, HIGH);
  } else {
    consecutiveFaultCycles++;
    if (consecutiveFaultCycles > 10) {
      digitalWrite(ledPin, (nowMs / 250) % 2);
      if (!faultReported) pendingFault = true;
    }
  }
  scanIndex = -1;
  waitingForGap = false;
}

void serviceSensors(unsigned long nowMs) {
  if (scanIndex < 0) {
    if (nowMs - lastCycle < 60) return;
    lastCycle = nowMs;
    scanIndex = 0;
    cycleHadEcho = false;
    if (sensorEnabled[scanIndex]) triggerSensor(scanIndex);
    else finishSensor(scanIndex, -1, nowMs);
    if (!sensorEnabled[scanIndex]) {
      scanIndex++;
      waitingForGap = true;
      nextTriggerUs = micros() + sensorGapUs;
    }
    return;
  }

  if (waitingForGap) {
    if (static_cast<int32_t>(micros() - nextTriggerUs) < 0) return;
    if (scanIndex >= sensorCount) { completeSensorCycle(nowMs); return; }
    if (sensorEnabled[scanIndex]) {
      triggerSensor(scanIndex);
      waitingForGap = false;
    } else {
      finishSensor(scanIndex, -1, nowMs);
      scanIndex++;
      nextTriggerUs = micros() + sensorGapUs;
    }
    return;
  }

  const bool timedOut = micros() - scanStartedUs >= echoTimeoutUs;
  if (!echoComplete[scanIndex] && !timedOut) return;
  const float cm = echoComplete[scanIndex] ? echoDurationUs[scanIndex] * 0.0343f / 2.0f : -1;
  finishSensor(scanIndex, cm, nowMs);
  scanIndex++;
  waitingForGap = true;
  nextTriggerUs = micros() + sensorGapUs;
}

void updateMotors(unsigned long nowMs) {
  for (int i = 0; i < sensorCount; i++) {
    const unsigned long period = zones[i] == 1 ? 800 : zones[i] == 2 ? 400 : 1;
    const unsigned long onMs = zones[i] == 1 ? 100 : zones[i] == 2 ? 150 : 0;
    if (zones[i] > 0 && zones[i] < 3 && nowMs - pulseAt[i] >= period) pulseAt[i] = nowMs;
    const bool on = zones[i] == 3 || (zones[i] > 0 && nowMs - pulseAt[i] < onMs);
    const int pwm = zones[i] == 3 ? 255 : zones[i] == 2 ? intensity * 255 / 100 : zones[i] == 1 ? 102 : 0;
    ledcWrite(motorPins[i], on ? pwm : 0);
  }
}

void queueReading(float batteryV) {
  float nearest = 10000;
  for (int i = 0; i < sensorCount; i++) if (distances[i] >= 0 && distances[i] < nearest) nearest = distances[i];
  const char *zone = nearest < dangerCm ? "danger" : nearest < nearCm ? "near" : nearest < clearCm ? "far" : "clear";
  BufferedReading reading = {};
  reading.left = distances[0];
  reading.front = distances[1];
  reading.right = distances[2];
  reading.battery = batteryV;
  reading.zone = zone;
  const time_t epoch = time(nullptr);
  if (epoch > 1700000000) {
    struct tm utc;
    gmtime_r(&epoch, &utc);
    strftime(reading.timestamp, sizeof(reading.timestamp), "%Y-%m-%dT%H:%M:%SZ", &utc);
  }
  if (queueCount < 60) {
    queue[(queueStart + queueCount) % 60] = reading;
    queueCount++;
  } else {
    queue[queueStart] = reading;
    queueStart = (queueStart + 1) % 60;
  }
}

void flushReadings() {
  if (WiFi.status() != WL_CONNECTED || queueCount == 0) return;
  DynamicJsonDocument body(16000);
  JsonArray rows = body.to<JsonArray>();
  for (int i = 0; i < queueCount; i++) {
    const BufferedReading reading = queue[(queueStart + i) % 60];
    JsonObject row = rows.add<JsonObject>();
    if (reading.timestamp[0] != '\0') row["ts"] = reading.timestamp;
    if (reading.left < 0) row["left"] = nullptr; else row["left"] = reading.left;
    if (reading.front < 0) row["front"] = nullptr; else row["front"] = reading.front;
    if (reading.right < 0) row["right"] = nullptr; else row["right"] = reading.right;
    row["batteryV"] = reading.battery;
    row["batteryPct"] = static_cast<int>(constrain((reading.battery - 3.3f) * 100 / 0.9f, 0, 100));
    row["zone"] = reading.zone;
  }
  if (postJson("/api/readings", body)) {
    queueStart = (queueStart + queueCount) % 60;
    queueCount = 0;
  }
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < sensorCount; i++) {
    pinMode(trigPins[i], OUTPUT);
    pinMode(echoPins[i], INPUT);
    attachInterruptArg(digitalPinToInterrupt(echoPins[i]), onEchoEdge, reinterpret_cast<void *>(static_cast<intptr_t>(i)), CHANGE);
    ledcAttach(motorPins[i], 1000, 8);
  }
  pinMode(buzzerPin, OUTPUT);
  pinMode(sosPin, INPUT_PULLUP);
  pinMode(ledPin, OUTPUT);
  analogSetPinAttenuation(batteryPin, ADC_11db);
  lastConfig = millis() - 60000;
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
}

void loop() {
  const unsigned long nowMs = millis();
  serviceSensors(nowMs);
  updateMotors(nowMs);

  if (digitalRead(sosPin) == LOW) {
    if (sosStarted == 0) sosStarted = nowMs;
    if (nowMs - sosStarted >= 2000 && !sosSent) { sendAlert("sos"); sosSent = true; }
  } else { sosStarted = 0; sosSent = false; }

  if (nowMs - lastConfig >= 60000) { lastConfig = nowMs; refreshConfig(); }
  if (nowMs - lastPost >= 1000) {
    lastPost = nowMs;
    const float batteryV = analogRead(batteryPin) * 3.3f / 4095.0f * 2.0f;
    queueReading(batteryV);
    flushReadings();
    if (batteryV < 3.5f && !lowBatterySent) { sendAlert("low_battery"); lowBatterySent = true; }
    if (batteryV >= 3.5f) lowBatterySent = false;
  }

  for (int i = 0; i < sensorCount; i++) {
    if (pendingDanger[i]) { pendingDanger[i] = false; sendAlert("danger", i, distances[i]); }
  }
  if (pendingFault) { pendingFault = false; faultReported = true; sendAlert("sensor_fault"); }
}






