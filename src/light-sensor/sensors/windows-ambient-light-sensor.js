const { getAmbientLightSensors, getLuxValue } = require("windows-ambient-sensor");

const MAX_READ_ERRORS = 3;
const REDISCOVER_DELAY = 60000;

class WindowsAmbientLightSensor {
  constructor() {
    this.name = 'windows';
    this.settings = null;
    this.sendToAllWindows = null;
    this.onReading = null;
    this.interval = null;
    this.rediscoverTimer = null;
    this.sensorsAvailable = [];
    this.selectedSensorId = null;
    this.currentLux = null;
    this.readErrors = 0;
    this.bursting = false;
  }

  initialize(settings, sendToAllWindows, onReading) {
    this.settings = settings;
    this.sendToAllWindows = sendToAllWindows;
    this.onReading = onReading;
  }

  async changeSettings(settings, previous = {}) {
    const intervalChanged = settings.sensorPollingInterval !== previous.sensorPollingInterval;
    this.settings = settings;
    if (this.interval && intervalChanged) this._startPolling();
  }

  async connect() {
    console.log("Windows Ambient Light Sensor: Starting...");
    if (!this._discoverSensors()) {
      this._scheduleRediscovery();
      return;
    }
    this._pollLux();
    this._startPolling();
  }

  async reconnect() {
    await this.disconnect();
    await this.connect();
  }

  async disconnect() {
    this._stopPolling();
    if (this.rediscoverTimer) clearTimeout(this.rediscoverTimer);
    this.rediscoverTimer = null;
    this.sensorsAvailable = [];
    this.selectedSensorId = null;
    this.currentLux = null;
    this.readErrors = 0;
    this.onReading(null);
    this._sendStatus();
    console.log("Windows Ambient Light Sensor: Stopped");
  }

  _discoverSensors() {
    const startedAt = Date.now();
    try {
      this.sensorsAvailable = getAmbientLightSensors();
      this.selectedSensorId = this.sensorsAvailable[0]?.id ?? null;
      this.readErrors = 0;
      this._sendStatus();
      console.log(`Windows Ambient Light Sensor: discovered ${this.sensorsAvailable.length} sensor(s) in ${Date.now() - startedAt}ms`);
      return this.sensorsAvailable.length > 0;
    } catch (error) {
      console.error("Windows Ambient Light Sensor discovery error:", error);
      this.sensorsAvailable = [];
      this.selectedSensorId = null;
      this._sendStatus();
      return false;
    }
  }

  _pollLux() {
    if (this.sensorsAvailable.length === 0 || this.bursting) return;
    try {
      const lux = this._readLux();
      if (!Number.isFinite(lux) || lux < 0) throw new Error("Invalid lux value");
      this.currentLux = lux;
      this.readErrors = 0;
      this.onReading(lux);
      this._sendStatus();
    } catch (error) {
      this.readErrors++;
      console.error("Windows Ambient Light Sensor read error:", error);
      if (this.readErrors >= MAX_READ_ERRORS) {
        this.currentLux = null;
        this.sensorsAvailable = [];
        this.selectedSensorId = null;
        this.onReading(null);
        this._stopPolling();
        this._sendStatus();
        this._scheduleRediscovery();
      }
    }
  }

  _startPolling() {
    this._stopPolling();
    const interval = 1000 * (Number(this.settings?.sensorPollingInterval) || 1);
    this.interval = setInterval(() => this._pollLux(), interval);
  }

  _readLux() {
    return getLuxValue(this.selectedSensorId);
  }

  async sampleBurst(duration = 1000, interval = 100) {
    if (this.sensorsAvailable.length === 0) return [];
    this.bursting = true;
    const samples = [];
    const startedAt = Date.now();

    try {
      while (Date.now() - startedAt < duration) {
        const lux = this._readLux();
        if (Number.isFinite(lux) && lux >= 0) samples.push(lux);
        await new Promise(resolve => setTimeout(resolve, interval));
      }
    } finally {
      this.bursting = false;
    }

    if (samples.length > 0) this.currentLux = samples[samples.length - 1];
    return samples;
  }

  _stopPolling() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  _scheduleRediscovery() {
    if (this.rediscoverTimer) clearTimeout(this.rediscoverTimer);
    this.rediscoverTimer = setTimeout(() => {
      this.rediscoverTimer = null;
      if (this._discoverSensors()) {
        this._pollLux();
        this._startPolling();
      } else {
        this._scheduleRediscovery();
      }
    }, REDISCOVER_DELAY);
  }

  _sendStatus() {
    this.sendStatus();
  }

  getStatus() {
    return {
      sensorsAvailable: this.sensorsAvailable,
      sensorCount: this.sensorsAvailable.length,
      currentLux: this.currentLux
    };
  }

  sendStatus(send = this.sendToAllWindows) {
    send?.('light-sensor--windows', this.getStatus());
  }
}

module.exports = { WindowsAmbientLightSensor };
