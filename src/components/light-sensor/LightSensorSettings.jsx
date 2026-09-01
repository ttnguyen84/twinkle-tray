import { useCallback, useEffect, useState } from "react";
import { SettingsChild, SettingsOption } from "../SettingsOption";
import { YoctoSettings } from "./sensors/YoctoSettings";
import { FakeSensorSettings } from "./sensors/FakeSettings";
import { WindowsSettings } from "./sensors/WindowsSettings";

export function LightSensorSettings({ T }) {
  const lightSensorSettings = window.settings.lightSensor || {
    enabled: false,
    active: "windows",
    sensors: {
      yocto: { hubUrl: "user:password@localhost" },
      fake: { overriddenLux: 50 },
      windows: {}
    }
  };
  const activeSensor = lightSensorSettings.active || "windows";
  const daytimeBoost = lightSensorSettings.daytimeBoost || {
    enabled: false,
    luxOffset: 100,
    rampMinutes: 120
  };

  const [sensorStatus, setSensorStatus] = useState(null);

  useEffect(() => {
    const handleStatus = (e, status) => setSensorStatus(status);
    window.ipc.on("light-sensor-status", handleStatus);
    window.ipc.send("request-light-sensor-status");
    return () => {
      window.ipc.removeListener("light-sensor-status", handleStatus);
    };
  }, []);

  const setEnabled = useCallback((enabled) => {
    window.sendSettings({
      lightSensor: { ...lightSensorSettings, enabled }
    });
  }, [lightSensorSettings]);

  const setSensorType = useCallback((event) => {
    window.sendSettings({
      lightSensor: { ...lightSensorSettings, active: event.target.value }
    });
  }, [lightSensorSettings]);

  const updateDaytimeBoost = useCallback((changes) => {
    window.sendSettings({
      lightSensor: {
        ...lightSensorSettings,
        daytimeBoost: { ...daytimeBoost, ...changes }
      }
    });
  }, [lightSensorSettings, daytimeBoost]);

  const hasLocation = Boolean(
    window.settings.adjustmentTimeLatitude || window.settings.adjustmentTimeLongitude
  );

  const enabledToggle = (
    <div className="inputToggle-generic" data-textside="right">
      <input
        type="checkbox"
        checked={Boolean(lightSensorSettings.enabled)}
        data-checked={Boolean(lightSensorSettings.enabled)}
        onChange={event => setEnabled(event.target.checked)}
      />
      <div className="text">
        {lightSensorSettings.enabled ? T.t("GENERIC_ON") : T.t("GENERIC_OFF")}
      </div>
    </div>
  );

  const daytimeBoostToggle = (
    <div className="inputToggle-generic" data-textside="right">
      <input
        type="checkbox"
        checked={Boolean(daytimeBoost.enabled)}
        data-checked={Boolean(daytimeBoost.enabled)}
        onChange={event => updateDaytimeBoost({ enabled: event.target.checked })}
      />
      <div className="text">
        {daytimeBoost.enabled ? T.t("GENERIC_ON") : T.t("GENERIC_OFF")}
      </div>
    </div>
  );

  const daytimeOffsetValue = sensorStatus?.daytimeLuxOffset;
  const daytimeStatusText = daytimeBoost.enabled && hasLocation
    ? (daytimeOffsetValue > 0
      ? T.t("SETTINGS_LIGHT_SENSOR_DAYTIME_BOOST_STATUS_ACTIVE", Math.round(daytimeOffsetValue))
      : T.t("SETTINGS_LIGHT_SENSOR_DAYTIME_BOOST_STATUS_INACTIVE"))
    : null;

  return (
    <div className="pageSection">
      <div className="sectionTitle">{T.t("SETTINGS_LIGHT_SENSOR_TITLE")}</div>
      <p>{T.t("SETTINGS_LIGHT_SENSOR_DESC")}</p>
      <br />
      <SettingsOption title={T.t("SETTINGS_LIGHT_SENSOR_ENABLE")} input={enabledToggle}>
        <SettingsChild
          title={T.t("SETTINGS_LIGHT_SENSOR_TYPE_TITLE")}
          description={T.t("SETTINGS_LIGHT_SENSOR_TYPE_DESC")}
          input={
            <select value={activeSensor} onChange={setSensorType}>
              <option value="yocto">{T.t("SETTINGS_LIGHT_SENSOR_TYPE_YOCTO")}</option>
              <option value="fake">{T.t("SETTINGS_LIGHT_SENSOR_TYPE_FAKE")}</option>
              <option value="windows">{T.t("SETTINGS_LIGHT_SENSOR_TYPE_WINDOWS")}</option>
            </select>
          }
        />
      </SettingsOption>

      {lightSensorSettings.enabled && activeSensor === "yocto"
        ? <YoctoSettings T={T} lightSensorSettings={lightSensorSettings} />
        : null}
      {lightSensorSettings.enabled && activeSensor === "fake"
        ? <FakeSensorSettings T={T} lightSensorSettings={lightSensorSettings} />
        : null}
      {lightSensorSettings.enabled && activeSensor === "windows"
        ? <WindowsSettings T={T} />
        : null}

      {lightSensorSettings.enabled ? (
        <SettingsOption
          title={T.t("SETTINGS_LIGHT_SENSOR_DAYTIME_BOOST_TITLE")}
          description={T.t("SETTINGS_LIGHT_SENSOR_DAYTIME_BOOST_DESC")}
          input={daytimeBoostToggle}
        >
          {!hasLocation ? (
            <SettingsChild>
              <p style={{ color: "var(--warning-color, #e8912d)" }}>
                {T.t("SETTINGS_LIGHT_SENSOR_DAYTIME_BOOST_NO_LOCATION")}
              </p>
            </SettingsChild>
          ) : null}
          <SettingsChild
            title={T.t("SETTINGS_LIGHT_SENSOR_DAYTIME_BOOST_LUX_TITLE")}
            description={T.t("SETTINGS_LIGHT_SENSOR_DAYTIME_BOOST_LUX_DESC")}
            input={
              <input
                type="number"
                min="0"
                max="500"
                step="10"
                value={daytimeBoost.luxOffset ?? 100}
                onChange={e => updateDaytimeBoost({ luxOffset: Math.max(0, Number(e.target.value) || 0) })}
                style={{ maxWidth: "80px" }}
              />
            }
          />
          <SettingsChild
            title={T.t("SETTINGS_LIGHT_SENSOR_DAYTIME_BOOST_RAMP_TITLE")}
            description={T.t("SETTINGS_LIGHT_SENSOR_DAYTIME_BOOST_RAMP_DESC")}
            input={
              <input
                type="number"
                min="0"
                max="360"
                step="10"
                value={daytimeBoost.rampMinutes ?? 120}
                onChange={e => updateDaytimeBoost({ rampMinutes: Math.max(0, Number(e.target.value) || 0) })}
                style={{ maxWidth: "80px" }}
              />
            }
          />
          {daytimeStatusText ? (
            <SettingsChild>
              <p>{daytimeStatusText}</p>
            </SettingsChild>
          ) : null}
        </SettingsOption>
      ) : null}
    </div>
  );
}
