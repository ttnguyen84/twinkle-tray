require('yoctolib-es2017/yocto_api.js');
require('yoctolib-es2017/yocto_lightsensor.js');

const RECONNECT_DELAYS = [5000, 15000, 30000, 60000];

class YoctoLightSensor {
  constructor() {
    this.name = 'yocto';
    this.hubConnected = false;
    this.sensorConnected = false;
    this.sensor = null;
    this.currentLux = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.updateInterval = null;
    this.settings = null;
    this.sendToAllWindows = null;
    this.onReading = null;
  }

  initialize(settings, sendToAllWindows, onReading) {
    this.settings = settings;
    this.sendToAllWindows = sendToAllWindows;
    this.onReading = onReading;
  }

  async changeSettings(settings, previous = {}) {
    const connectionChanged = settings.sensors.yocto.hubUrl !== previous.sensors?.yocto?.hubUrl;
    const intervalChanged = settings.sensorPollingInterval !== previous.sensorPollingInterval;
    this.settings = settings;

    if (connectionChanged && this.hubConnected) {
      await this.reconnect();
    } else if (intervalChanged && this.hubConnected) {
      this._startPolling();
    }
  }

  async connect() {
    try {
      await YAPI.LogUnhandledPromiseRejections();
      await YAPI.DisableExceptions();

      const hubUrl = this.settings.sensors.yocto.hubUrl;
      console.log(`Yoctohub url: ${hubUrl}`);
      const result = await YAPI.RegisterHub(hubUrl);
      if (result !== YAPI.SUCCESS) throw new Error("Hub connection failed");

      this.hubConnected = true;
      this.reconnectAttempt = 0;
      YAPI.RegisterDeviceArrivalCallback(() => this._handleDeviceArrival());
      YAPI.RegisterDeviceRemovalCallback(() => this._handleDeviceRemoval());
      await YAPI.UpdateDeviceList();

      this.sensor = YLightSensor.FirstLightSensor();
      this.sensorConnected = Boolean(this.sensor && await this.sensor.isOnline());
      this._sendStatus();

      if (this.sensorConnected) {
        await this._update();
        this._startPolling();
      } else {
        this._scheduleReconnect();
      }
    } catch (error) {
      console.error("Yocto connection error:", error);
      this.hubConnected = false;
      this.sensorConnected = false;
      this.currentLux = null;
      this.onReading(null);
      this._sendStatus();
      this._scheduleReconnect();
    }
  }

  async reconnect() {
    await this.disconnect();
    await this.connect();
  }

  async disconnect() {
    this._stopPolling();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      await YAPI.FreeAPI();
    } catch (error) {
      console.error("Error freeing YAPI", error);
    }
    this.hubConnected = false;
    this.sensorConnected = false;
    this.sensor = null;
    this.currentLux = null;
    this.onReading(null);
    this._sendStatus();
  }

  async _handleDeviceArrival() {
    this.sensor = YLightSensor.FirstLightSensor();
    this.sensorConnected = Boolean(this.sensor && await this.sensor.isOnline());
    if (this.sensorConnected) {
      this.reconnectAttempt = 0;
      await this._update();
      this._startPolling();
    }
    this._sendStatus();
  }

  _handleDeviceRemoval() {
    this.sensorConnected = false;
    this.sensor = null;
    this.currentLux = null;
    this.onReading(null);
    this._stopPolling();
    this._sendStatus();
    this._scheduleReconnect();
  }

  async _update() {
    if (!this.hubConnected || !this.sensorConnected || !this.sensor) return;

    try {
      await YAPI.HandleEvents();
      if (!await this.sensor.isOnline()) throw new Error("Light sensor is offline");

      const lux = await this.sensor.get_currentRawValue();
      if (!Number.isFinite(lux) || lux < 0) throw new Error("Invalid lux value");

      this.currentLux = lux;
      this.onReading(lux);
      this._sendStatus();
    } catch (error) {
      console.error("Yocto polling error:", error);
      this.sensorConnected = false;
      this.currentLux = null;
      this.onReading(null);
      this._stopPolling();
      this._sendStatus();
      this._scheduleReconnect();
    }
  }

  _startPolling() {
    this._stopPolling();
    const interval = 1000 * (Number(this.settings?.sensorPollingInterval) || 1);
    this.updateInterval = setInterval(() => this._update(), interval);
  }

  _stopPolling() {
    if (this.updateInterval) clearInterval(this.updateInterval);
    this.updateInterval = null;
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await YAPI.FreeAPI();
      } catch (error) {
        console.error("Error freeing YAPI", error);
      }
      await this.connect();
    }, delay);
  }

  _sendStatus() {
    this.sendStatus();
  }

  getStatus() {
    return {
      hubConnected: this.hubConnected,
      sensorConnected: this.sensorConnected,
      lux: this.currentLux
    };
  }

  sendStatus(send = this.sendToAllWindows) {
    send?.('light-sensor--yocto', this.getStatus());
  }
}

module.exports = { YoctoLightSensor };
