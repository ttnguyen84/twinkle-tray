const { parentPort } = require("worker_threads");
const { getAmbientLightSensors, getLuxValue } = require("windows-ambient-sensor");

if (!parentPort) {
  process.exit(1);
}

parentPort.on("message", (msg) => {
  const { id, type, payload } = msg;
  try {
    if (type === "discover") {
      const sensors = getAmbientLightSensors();
      parentPort.postMessage({ id, success: true, result: sensors });
    } else if (type === "readLux") {
      const lux = getLuxValue(payload?.sensorId);
      parentPort.postMessage({ id, success: true, result: lux });
    } else {
      parentPort.postMessage({ id, success: false, error: `Unknown request type: ${type}` });
    }
  } catch (error) {
    parentPort.postMessage({ id, success: false, error: error?.message || String(error) });
  }
});
