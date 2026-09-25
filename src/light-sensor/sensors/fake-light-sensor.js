class FakeLightSensor {
  constructor() {
    this.name = 'fake';
    this.settings = null;
    this.sendToAllWindows = null;
    this.onReading = null;
  }

  initialize(settings, sendToAllWindows, onReading) {
    this.settings = settings
    this.sendToAllWindows = sendToAllWindows
    this.onReading = onReading
  }

  async reconnect() { }

  async changeSettings(settings, previous = {}) {
    this.settings = settings;
    if (this.settings.enabled && settings.sensors.fake.overriddenLux !== previous.sensors?.fake?.overriddenLux) {
      this.onReading(settings.sensors.fake.overriddenLux);
    }
  }

  async connect() {
    this.onReading(this.settings.sensors.fake.overriddenLux);
  }

  async disconnect() { }
}

module.exports = { FakeLightSensor };
