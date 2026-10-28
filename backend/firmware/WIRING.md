# Wiring (ESP32 DevKit 30-pin)

Use a common ground for ESP32, all sensors, motor transistor emitters, and battery measurement. Power HC-SR04 modules from VIN (5 V). Each ECHO output is 5 V: use a divider with 1 kΩ from ECHO to GPIO and 2 kΩ from GPIO to GND. Do not connect ECHO directly to ESP32.

| Part | Signal | ESP32 |
|---|---|---|
| Left HC-SR04 | TRIG / ECHO divider | GPIO 13 / 14 |
| Front HC-SR04 | TRIG / ECHO divider | GPIO 25 / 26 |
| Right HC-SR04 | TRIG / ECHO divider | GPIO 27 / 33 |
| Left motor driver | transistor base via 1 kΩ | GPIO 18 |
| Front motor driver | transistor base via 1 kΩ | GPIO 19 |
| Right motor driver | transistor base via 1 kΩ | GPIO 21 |
| Optional active buzzer | control | GPIO 23 |
| SOS push button | other side to GND | GPIO 32, INPUT_PULLUP |
| Battery divider midpoint | 100 kΩ + 100 kΩ divider | GPIO 35 |
| Status LED | onboard status | GPIO 2 |

For each motor, connect motor positive to its rated supply and motor negative to the NPN collector; emitter to GND. Place a flyback diode across each motor (cathode at supply positive). Never power motors from a GPIO. Battery divider: battery positive -> 100 kΩ -> ADC midpoint -> 100 kΩ -> GND. Do not use GPIO 0, 12, 15, or 6-11.
