const test = require('node:test');
const assert = require('node:assert/strict');
const { outputsConverged, resolveLinkedLevel } = require('../src/brightness-session');
const { LightSensor } = require('../src/light-sensor/light-sensor');
const {
  getCalibratedValue,
  normalizeCalibrationPoints,
  quantizeBrightness,
  upsertCalibrationPoint
} = require('../src/Utils');
const {
  AUTO_BRIGHTNESS_CURVE,
  clampBrightness,
  getAdaptiveDelay,
  getBrightnessFromLux,
  getBurstLux,
  getDaytimeLuxOffset,
  getMedianLux,
  getTargetDeadband,
  getTransitionPlan,
  learnBrightnessCurve
} = require('../src/light-sensor/light-sensor.utilts');

function createSensor(monitors = []) {
  const sensor = new LightSensor();
  sensor.settings = {
    enabled: true,
    active: 'fake',
    sensorPollingInterval: 1,
    minLux: 50,
    maxLux: 500,
    learnedAdjustments: [0, 0, 0, 0, 0, 0, 0],
    sensors: { yocto: {}, fake: {}, windows: {} }
  };
  sensor.monitors = Object.fromEntries(monitors.map(monitor => [monitor.key, monitor]));
  sensor.applyBrightness = (id, level) => {
    const monitor = sensor._findMonitor(id);
    if (monitor) monitor.brightness = level;
  };
  sensor.notifyMonitors = () => {};
  sensor.notifySettings = () => {};
  sensor.writeSettings = () => {};
  sensor.canControlMonitor = () => true;
  sensor.canApplyBrightness = () => true;
  return sensor;
}

test('maps lux through the requested nonlinear curve', () => {
  assert.equal(getBrightnessFromLux(50, 50, 500), 0);
  assert.equal(getBrightnessFromLux(500, 50, 500), 100);
  assert.equal(getBrightnessFromLux(140, 50, 500), 10);
  assert.equal(getBrightnessFromLux(275, 50, 500), 37);
  assert.deepEqual(
    AUTO_BRIGHTNESS_CURVE.map(point => point.brightness),
    [0, 3, 10, 24, 48, 75, 100]
  );
});

test('keeps the automatic curve continuous and monotonic', () => {
  let previous = -1;
  for (let lux = 50; lux <= 500; lux += 5) {
    const brightness = getBrightnessFromLux(lux, 50, 500);
    assert.ok(brightness >= previous);
    previous = brightness;
  }
});

test('learns one global preference near the current lux', () => {
  const lux = 50 + (0.38 * 450);
  const learned = learnBrightnessCurve([], lux, 50, 500, 40);
  assert.equal(getBrightnessFromLux(lux, 50, 500, learned), 40);
  assert.equal(getBrightnessFromLux(500, 50, 500, learned), 100);
  assert.ok(getBrightnessFromLux(140, 50, 500, learned) > 10);
});

test('normalizes calibration points without mutating settings', () => {
  const points = [
    { input: 50, output: 40 },
    { input: 20, output: 30 },
    { input: 50, output: 60 },
    { input: 80, output: 55 }
  ];
  const snapshot = structuredClone(points);
  const normalized = normalizeCalibrationPoints(points, false);
  assert.deepEqual(points, snapshot);
  assert.deepEqual(normalized, [
    { input: 20, output: 30 },
    { input: 50, output: 60 },
    { input: 80, output: 60 }
  ]);
});

test('upserts at most one calibration point around the same Link level', () => {
  let points = upsertCalibrationPoint([], 50, 60);
  points = upsertCalibrationPoint(points, 50.2, 55);
  assert.equal(points.length, 1);
  assert.deepEqual(points[0], { input: 50.2, output: 55 });
});

test('calibration can map Link level forward and infer it in reverse', () => {
  const points = [{ input: 50, output: 60 }];
  assert.equal(getCalibratedValue(50, points), 60);
  assert.equal(getCalibratedValue(60, points, true), 50);
});

test('quantizes calibrated hardware brightness to a valid integer', () => {
  assert.equal(quantizeBrightness(21.935), 22);
  assert.equal(quantizeBrightness(-5), 0);
  assert.equal(quantizeBrightness(275, 0, 255), 255);
});

test('two converged monitor outputs promote the shared Link level', () => {
  assert.equal(resolveLinkedLevel({
    startLevel: 50,
    previewLevel: 50,
    linkTouched: false,
    outputLevels: [70, 70],
    individualTouched: true
  }), 70);
});

test('two of three monitors do not move the shared Link level', () => {
  assert.equal(resolveLinkedLevel({
    startLevel: 50,
    previewLevel: 50,
    linkTouched: false,
    outputLevels: [60, 60, 50],
    individualTouched: true
  }), 50);
});

test('small output differences resolve to the median Link level', () => {
  assert.equal(resolveLinkedLevel({
    startLevel: 50,
    previewLevel: 50,
    linkTouched: false,
    outputLevels: [59, 60, 61],
    individualTouched: true
  }), 60);
});

test('Link remains virtual when calibrated outputs have not converged', () => {
  assert.equal(resolveLinkedLevel({
    startLevel: 50,
    previewLevel: 80,
    linkTouched: true,
    outputLevels: [100, 75],
    individualTouched: false
  }), 80);
  assert.equal(outputsConverged([100, 75]), false);
});

test('piecewise calibration permits early minimum and maximum plateaus', () => {
  const points = [
    { input: 30, output: 0 },
    { input: 80, output: 100 }
  ];
  assert.equal(getCalibratedValue(20, points), 0);
  assert.equal(getCalibratedValue(30, points), 0);
  assert.equal(getCalibratedValue(80, points), 100);
  assert.equal(getCalibratedValue(90, points), 100);
});

test('builds one global Link target for every controllable monitor', () => {
  const monitorA = { key: 'display-a', id: 'display-a-id', brightness: 10 };
  const monitorB = { key: 'display-b', id: 'display-b-id', brightness: 80 };
  const sensor = createSensor([monitorA, monitorB]);
  const targets = sensor._buildTargets(140);
  assert.equal(targets[monitorA.key].targetBrightness, 10);
  assert.equal(targets[monitorB.key].targetBrightness, 10);
});

test('learning the Link level updates only the global lux curve', () => {
  const sensor = createSensor();
  sensor.filteredLux = 50 + (0.38 * 450);
  sensor.currentLux = sensor.filteredLux;
  let writes = 0;
  sensor.writeSettings = () => { writes += 1; };
  assert.equal(sensor.learnLinkLevel(40), true);
  assert.equal(getBrightnessFromLux(
    sensor.filteredLux,
    sensor.settings.minLux,
    sensor.settings.maxLux,
    sensor.settings.learnedAdjustments
  ), 40);
  assert.equal(sensor.settings.monitorSettings, undefined);
  assert.equal(writes, 1);
});

test('migrates one legacy learned curve and removes per-monitor sensor settings', () => {
  const sensor = new LightSensor();
  const healed = sensor._healSettings({
    enabled: true,
    active: 'fake',
    sensorPollingInterval: 30,
    monitorSettings: {
      display: {
        enabled: true,
        manualOffset: 10,
        balanceOffset: -5,
        learnedAdjustments: [0, 1, 2, 3, 2, 1, 0]
      }
    }
  }, () => {});
  assert.deepEqual(healed.learnedAdjustments, [0, 1, 2, 3, 2, 1, 0]);
  assert.equal(healed.monitorSettings, undefined);
  assert.equal(healed.sensorPollingInterval, 1);
});

test('manual interaction pauses Auto for ten seconds without disabling it', () => {
  const monitor = { key: 'display', id: 'display-id', brightness: 10 };
  const sensor = createSensor([monitor]);
  sensor.filteredLux = 500;
  sensor.currentLux = 500;
  sensor.pauseManual();
  assert.equal(sensor.settings.enabled, true);
  assert.ok(sensor.manualPauseUntil - Date.now() > 9000);
  sensor._processReading(500, { resume: true });
  assert.equal(Object.keys(sensor.ramps).length, 0);
  clearTimeout(sensor.manualPauseTimer);
});

test('wake recovery can bypass only the wake guard and await the brightness write', async () => {
  const monitor = { key: 'display', id: 'display-id', brightness: 10 };
  const sensor = createSensor([monitor]);
  const targets = {
    display: { key: 'display', targetBrightness: 60 }
  };
  sensor.canApplyBrightness = (_monitor, options) => options.allowDuringWakeRecovery === true;

  assert.equal(await sensor.applyImmediateTargets(targets), false);

  let finishWrite;
  sensor.applyBrightness = () => new Promise(resolve => { finishWrite = resolve; });
  const applying = sensor.applyImmediateTargets(targets, {
    allowDuringWakeRecovery: true,
    awaitWrites: true
  });
  let settled = false;
  applying.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);

  finishWrite(true);
  assert.equal(await applying, true);
});

test('popup session keeps Auto paused until the session closes', () => {
  const sensor = createSensor();
  sensor.setManualSessionActive(true);
  sensor.manualPauseUntil = 0;
  assert.equal(sensor._isManuallyPaused(), true);
  sensor.setManualSessionActive(false);
  assert.equal(sensor._isManuallyPaused(), false);
});

test('drops stale monitor state and ramps after disconnect', () => {
  const sensor = createSensor([
    { key: 'display-1', id: 'OLD-ID' },
    { key: 'display-2', id: 'KEEP-ID' }
  ]);
  sensor.monitorStates = { 'display-1': {}, 'display-2': {} };
  sensor.ramps = {
    'display-1': { monitorId: 'OLD-ID' },
    'display-2': { monitorId: 'KEEP-ID' }
  };
  const remaining = { key: 'display-2', id: 'KEEP-ID' };
  sensor.setMonitors({ newSlot: remaining });
  assert.deepEqual(Object.keys(sensor.monitorStates), ['display-2']);
  assert.deepEqual(Object.keys(sensor.ramps), ['display-2']);
  assert.equal(sensor._findMonitor('display-2'), remaining);
});

test('uses a median and adaptive deadband for noisy readings', () => {
  assert.equal(getMedianLux([50, 52, 400]), 52);
  assert.equal(getMedianLux([50, 52, 54, 400]), 53);
  assert.equal(getTargetDeadband(10), 2);
  assert.equal(getTargetDeadband(40), 3);
  assert.equal(getTargetDeadband(80), 4);
});

test('waits longer before dimming and limits transition speed', () => {
  assert.equal(getAdaptiveDelay(1), Infinity);
  assert.equal(getAdaptiveDelay(3), 4000);
  assert.equal(getAdaptiveDelay(3, true), 6000);
  const brightening = getTransitionPlan(50, false);
  const dimming = getTransitionPlan(50, true);
  assert.equal(brightening.fastRatio, 0.4);
  assert.equal(dimming.fastRatio, 0.25);
  assert.ok(dimming.fastDuration + dimming.slowDuration
    > brightening.fastDuration + brightening.slowDuration);
});

test('rejects brief shadows and clamps final brightness', () => {
  const samples = [10, 10, 11, 12, 80];
  assert.equal(getBurstLux(samples, false), 11);
  assert.equal(getBurstLux(samples, true), 12);
  assert.equal(clampBrightness(-10), 0);
  assert.equal(clampBrightness(45.6), 46);
  assert.equal(clampBrightness(120), 100);
});

test('readback detects manual brightness change and learns preference', async () => {
  const monitor = { id: 'M1', key: 'mon1', type: 'ddcci', brightness: 50, brightnessRaw: 50, brightnessType: true };
  const sensor = createSensor([monitor]);
  let linkedLevel = null;
  sensor.setLinkedLevel = level => { linkedLevel = level; };
  sensor.readMonitorBrightness = async () => ({
    brightness: 70,
    normalizedBrightness: 70
  });
  sensor.active = sensor.sensors.fake;
  sensor.filteredLux = 200;
  sensor.currentLux = 200;
  sensor.lastWriteAt = 0;
  sensor.wakeGraceUntil = 0;

  await sensor._tickReadback();

  assert.equal(monitor.brightness, 70, 'monitor brightness updated');
  assert.equal(monitor.brightnessRaw, 70, 'monitor brightnessRaw updated');
  assert.ok(sensor.manualPauseUntil > Date.now(), 'manual pause activated');
  assert.equal(linkedLevel, 70, 'linked level updated');
});

test('readback skipped during wake grace period', async () => {
  const monitor = { id: 'M1', key: 'mon1', type: 'ddcci', brightness: 50, brightnessRaw: 50, brightnessType: true };
  const sensor = createSensor([monitor]);
  let readCalled = false;
  sensor.readMonitorBrightness = async () => { readCalled = true; return { brightness: 75, normalizedBrightness: 75 }; };
  sensor.active = sensor.sensors.fake;
  sensor.filteredLux = 200;
  sensor.wakeGraceUntil = Date.now() + 5000;
  sensor.lastWriteAt = 0;

  await sensor._tickReadback();

  assert.equal(readCalled, false, 'readback should not call read during grace period');
  assert.equal(monitor.brightness, 50, 'brightness unchanged');
});

test('readback skipped after recent brightness write', async () => {
  const monitor = { id: 'M1', key: 'mon1', type: 'ddcci', brightness: 50, brightnessRaw: 50, brightnessType: true };
  const sensor = createSensor([monitor]);
  let readCalled = false;
  sensor.readMonitorBrightness = async () => { readCalled = true; return { brightness: 75, normalizedBrightness: 75 }; };
  sensor.active = sensor.sensors.fake;
  sensor.filteredLux = 200;
  sensor.wakeGraceUntil = 0;
  sensor.lastWriteAt = Date.now(); // Just wrote

  await sensor._tickReadback();

  assert.equal(readCalled, false, 'readback should not call read after recent write');
  assert.equal(monitor.brightness, 50, 'brightness unchanged');
});

// --- Daytime Lux Boost tests ---

test('getDaytimeLuxOffset returns 0 when disabled', () => {
  assert.equal(getDaytimeLuxOffset(Date.now(), null), 0);
  assert.equal(getDaytimeLuxOffset(Date.now(), { enabled: false, luxOffset: 100 }), 0);
  assert.equal(getDaytimeLuxOffset(Date.now(), { enabled: true, luxOffset: 0 }), 0);
});

test('getDaytimeLuxOffset returns 0 when outside sunrise-sunset', () => {
  const sunrise = new Date('2025-06-15T06:00:00').getTime();
  const sunset = new Date('2025-06-15T18:00:00').getTime();
  const boost = { enabled: true, luxOffset: 100, rampMinutes: 120, sunriseMs: sunrise, sunsetMs: sunset };
  // Before sunrise
  const before = new Date('2025-06-15T05:30:00').getTime();
  assert.equal(getDaytimeLuxOffset(before, boost), 0);
  // After sunset
  const after = new Date('2025-06-15T18:30:00').getTime();
  assert.equal(getDaytimeLuxOffset(after, boost), 0);
});

test('getDaytimeLuxOffset ramps up linearly after sunrise', () => {
  const sunrise = new Date('2025-06-15T06:00:00').getTime();
  const sunset = new Date('2025-06-15T18:00:00').getTime();
  const boost = { enabled: true, luxOffset: 100, rampMinutes: 120, sunriseMs: sunrise, sunsetMs: sunset };
  // At sunrise: 0
  assert.equal(getDaytimeLuxOffset(sunrise, boost), 0);
  // 1 hour after sunrise: 50%
  const oneHour = sunrise + 60 * 60 * 1000;
  assert.equal(Math.round(getDaytimeLuxOffset(oneHour, boost)), 50);
  // 2 hours after sunrise: 100%
  const twoHours = sunrise + 120 * 60 * 1000;
  assert.equal(getDaytimeLuxOffset(twoHours, boost), 100);
});

test('getDaytimeLuxOffset returns full offset during midday', () => {
  const sunrise = new Date('2025-06-15T06:00:00').getTime();
  const sunset = new Date('2025-06-15T18:00:00').getTime();
  const boost = { enabled: true, luxOffset: 200, rampMinutes: 120, sunriseMs: sunrise, sunsetMs: sunset };
  const noon = new Date('2025-06-15T12:00:00').getTime();
  assert.equal(getDaytimeLuxOffset(noon, boost), 200);
});

test('getDaytimeLuxOffset ramps down linearly before sunset', () => {
  const sunrise = new Date('2025-06-15T06:00:00').getTime();
  const sunset = new Date('2025-06-15T18:00:00').getTime();
  const boost = { enabled: true, luxOffset: 100, rampMinutes: 120, sunriseMs: sunrise, sunsetMs: sunset };
  // 2 hours before sunset: start ramp down = 100
  const rampStart = sunset - 120 * 60 * 1000;
  assert.equal(getDaytimeLuxOffset(rampStart, boost), 100);
  // 1 hour before sunset: 50%
  const oneHourBefore = sunset - 60 * 60 * 1000;
  assert.equal(Math.round(getDaytimeLuxOffset(oneHourBefore, boost)), 50);
  // At sunset: 0
  assert.equal(getDaytimeLuxOffset(sunset, boost), 0);
});

test('getDaytimeLuxOffset handles overlapping ramp periods (very short day)', () => {
  const sunrise = new Date('2025-06-15T10:00:00').getTime();
  const sunset = new Date('2025-06-15T12:00:00').getTime(); // only 2 hours of daylight
  const boost = { enabled: true, luxOffset: 100, rampMinutes: 120, sunriseMs: sunrise, sunsetMs: sunset };
  // Midpoint at 11:00
  const midpoint = new Date('2025-06-15T11:00:00').getTime();
  assert.equal(getDaytimeLuxOffset(midpoint, boost), 100);
  // Halfway through ramp up (10:30)
  const halfUp = new Date('2025-06-15T10:30:00').getTime();
  assert.equal(Math.round(getDaytimeLuxOffset(halfUp, boost)), 50);
});

test('getDaytimeLuxOffset returns 0 for invalid sun times', () => {
  assert.equal(getDaytimeLuxOffset(Date.now(), { enabled: true, luxOffset: 100, sunriseMs: null, sunsetMs: null }), 0);
  assert.equal(getDaytimeLuxOffset(Date.now(), { enabled: true, luxOffset: 100, sunriseMs: 100, sunsetMs: 50 }), 0);
});

test('_buildTargets includes daytime offset in brightness calculation', () => {
  const monitor = { key: 'display-a', id: 'display-a-id', brightness: 10 };
  const sensor = createSensor([monitor]);
  // Without boost
  const noBoostTargets = sensor._buildTargets(200);
  // With boost: add daytimeBoost settings
  const sunrise = Date.now() - 3 * 60 * 60 * 1000; // 3 hours ago
  const sunset = Date.now() + 6 * 60 * 60 * 1000;  // 6 hours from now
  sensor.settings.daytimeBoost = {
    enabled: true,
    luxOffset: 100,
    rampMinutes: 120,
    sunriseMs: sunrise,
    sunsetMs: sunset
  };
  const boostTargets = sensor._buildTargets(200);
  // With offset, effective lux = 300, so brightness should be higher
  assert.ok(boostTargets[monitor.key].targetBrightness > noBoostTargets[monitor.key].targetBrightness,
    'daytime boost should increase brightness target');
});
