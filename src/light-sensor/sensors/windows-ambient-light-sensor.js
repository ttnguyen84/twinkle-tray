const path = require("path");
const { Worker } = require("worker_threads");

const MAX_READ_ERRORS = 3;
const REDISCOVER_DELAY = 60000;
const CALL_TIMEOUT = 2500;

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
    this.worker = null;
    this.requestId = 0;
    this.pendingCalls = new Map();
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

  _initWorker() {
    if (this.worker) return;
    try {
      const workerPath = path.join(__dirname, "windows-ambient-sensor-worker.js");
      this.worker = new Worker(workerPath);
      this.worker.on("message", (msg) => {
        const { id, success, result, error } = msg;
        const pending = this.pendingCalls.get(id);
        if (pending) {
          this.pendingCalls.delete(id);
          clearTimeout(pending.timer);
          if (success) pending.resolve(result);
          else pending.reject(new Error(error));
        }
      });
      this.worker.on("error", (err) => {
        console.error("Windows Ambient Sensor worker error:", err);
        this._terminateWorker();
      });
      this.worker.on("exit", (code) => {
        if (code !== 0) console.warn(`Windows Ambient Sensor worker exited with code ${code}`);
        this._cleanupPending(new Error("Worker terminated"));
        this.worker = null;
      });
    } catch (e) {
      console.error("Failed to spawn Windows Ambient Sensor worker:", e);
    }
  }

  _terminateWorker() {
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch (e) {}
      this.worker = null;
    }
    this._cleanupPending(new Error("Worker terminated"));
  }

  _cleanupPending(err) {
    for (const [id, pending] of this.pendingCalls.entries()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingCalls.clear();
  }

  async _callWorker(type, payload = {}, timeoutMs = CALL_TIMEOUT) {
    this._initWorker();
    if (!this.worker) throw new Error("Worker unavailable");

    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(id);
        console.warn(`Windows Ambient Sensor call '${type}' timed out after ${timeoutMs}ms, terminating worker.`);
        this._terminateWorker();
        reject(new Error(`Call '${type}' timed out`));
      }, timeoutMs);

      this.pendingCalls.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, type, payload });
    });
  }

  async connect() {
    console.log("Windows Ambient Light Sensor: Starting...");
    const ok = await this._discoverSensors();
    if (!ok) {
      this._scheduleRediscovery();
      return;
    }
    await this._pollLux();
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
    this._terminateWorker();
    this.sensorsAvailable = [];
    this.selectedSensorId = null;
    this.currentLux = null;
    this.readErrors = 0;
    this.onReading?.(null);
    this._sendStatus();
    console.log("Windows Ambient Light Sensor: Stopped");
  }

  async _discoverSensors() {
    const startedAt = Date.now();
    try {
      const sensors = await this._callWorker("discover", {}, 2500);
      this.sensorsAvailable = Array.isArray(sensors) ? sensors : [];
      this.selectedSensorId = this.sensorsAvailable[0]?.id ?? null;
      this.readErrors = 0;
      this._sendStatus();
      console.log(`Windows Ambient Light Sensor: discovered ${this.sensorsAvailable.length} sensor(s) in ${Date.now() - startedAt}ms`);
      return this.sensorsAvailable.length > 0;
    } catch (error) {
      console.error("Windows Ambient Light Sensor discovery error:", error?.message || error);
      this.sensorsAvailable = [];
      this.selectedSensorId = null;
      this._sendStatus();
      return false;
    }
  }

  async _pollLux() {
    if (this.sensorsAvailable.length === 0 || this.bursting) return;
    try {
      const lux = await this._readLux();
      if (!Number.isFinite(lux) || lux < 0) throw new Error("Invalid lux value");
      this.currentLux = lux;
      this.readErrors = 0;
      this.onReading?.(lux);
      this._sendStatus();
    } catch (error) {
      this.readErrors++;
      console.error("Windows Ambient Light Sensor read error:", error?.message || error);
      if (this.readErrors >= MAX_READ_ERRORS) {
        this.currentLux = null;
        this.sensorsAvailable = [];
        this.selectedSensorId = null;
        this.onReading?.(null);
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

  async _readLux() {
    return await this._callWorker("readLux", { sensorId: this.selectedSensorId }, 1500);
  }

  async sampleBurst(duration = 1000, interval = 100) {
    if (this.sensorsAvailable.length === 0) return [];
    this.bursting = true;
    const samples = [];
    const startedAt = Date.now();

    try {
      while (Date.now() - startedAt < duration) {
        const lux = await this._readLux().catch(() => null);
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
    this.rediscoverTimer = setTimeout(async () => {
      this.rediscoverTimer = null;
      if (await this._discoverSensors()) {
        await this._pollLux();
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
