import React, { memo, useEffect, useMemo, useState } from "react";
import Slider from "./Slider";
import DDCCISliders from "./DDCCISliders";
import HDRSliders from "./HDRSliders";
import TranslateReact from "../TranslateReact";
import getMonitorName from "../utils/BrightnessPanel/getMonitorName";

function usesGammaSlider(monitor) {
  return Boolean(
    window.settings?.gammaAsMainSliderDisplays?.[monitor?.key]
    && monitor?.gammaBrightness >= 0
  )
}

function isVisibleMonitor(monitor) {
  if (!monitor || window.settings?.hideDisplays?.[monitor.key] === true) return false
  return monitor.type === "wmi"
    || monitor.type === "studio-display"
    || monitor.type === "software"
    || (monitor.type === "ddcci" && monitor.brightnessType)
    || monitor.hdr === "active"
    || usesGammaSlider(monitor)
}

const BrightnessPanel = memo(function BrightnessPanel() {
  const [state, setState] = useState({
    monitors: window.allMonitors || {},
    hideDisplays: window.settings?.hideDisplays || {},
    linkedLevel: window.settings?.linkedLevel ?? 50,
    showPanelDetails: window.settings?.showPanelDetails ?? false,
    adjustmentActive: false,
    names: window.settings?.names || {},
    update: false,
    sleeping: false,
    updateProgress: 0,
    isRefreshing: window.isRefreshing,
    lightSensor: window.settings?.lightSensor || {},
    lightSensorStatus: window.lightSensorStatus || {}
  })
  const [T] = useState(new TranslateReact({}, {}))
  const [, setLocalizationVersion] = useState(0)

  const visibleMonitors = useMemo(() => Object.values(state.monitors)
    .filter(isVisibleMonitor)
    .sort((left, right) => {
      const leftOrder = left.order === undefined ? 999 : Number(left.order)
      const rightOrder = right.order === undefined ? 999 : Number(right.order)
      return leftOrder - rightOrder
    }), [state.monitors, state.hideDisplays])

  const toggleAutoBrightness = (enabled) => {
    setState(current => ({
      ...current,
      lightSensor: { ...current.lightSensor, enabled }
    }))
    window.setAutoBrightnessEnabled(enabled)
  }

  const handleLinkChange = (level) => {
    setState(current => ({ ...current, linkedLevel: level, adjustmentActive: true }))
    window.previewPanelBrightness({ type: "link", level })
    window.pauseMonitorUpdates()
  }

  const handleMonitorChange = (level, slider) => {
    const key = slider.props.hwid
    setState(current => ({
      ...current,
      adjustmentActive: true,
      monitors: {
        ...current.monitors,
        [key]: {
          ...current.monitors[key],
          brightnessRaw: level
        }
      }
    }))
    window.previewPanelBrightness({ type: "monitor", key, level })
    window.pauseMonitorUpdates()
  }

  const toggleDetails = (showPanelDetails) => {
    setState(current => ({ ...current, showPanelDetails }))
    window.sendSettings({ showPanelDetails })
  }

  useEffect(() => {
    const handleMonitorsUpdated = event => {
      setState(current => ({ ...current, monitors: { ...event.detail } }))
    }
    const handleSettingsUpdated = event => {
      const settings = event.detail
      setState(current => ({
        ...current,
        linkedLevel: current.adjustmentActive
          ? current.linkedLevel
          : (settings.linkedLevel ?? current.linkedLevel),
        showPanelDetails: settings.showPanelDetails ?? false,
        hideDisplays: settings.hideDisplays || {},
        names: settings.names || {},
        lightSensor: settings.lightSensor || {},
        sleepAction: settings.sleepAction ?? "none"
      }))
    }
    const handleLocalizationUpdated = event => {
      T.setLocalizationData(event.detail.desired, event.detail.default)
      setLocalizationVersion(version => version + 1)
    }
    const handleUpdateUpdated = event => setState(current => ({ ...current, update: event.detail }))
    const handleSleepUpdated = event => setState(current => ({
      ...current,
      sleeping: event.detail,
      adjustmentActive: event.detail ? false : current.adjustmentActive,
      linkedLevel: event.detail
        ? (window.settings?.linkedLevel ?? current.linkedLevel)
        : current.linkedLevel
    }))
    const handleRefreshingUpdated = event => setState(current => ({ ...current, isRefreshing: event.detail }))
    const handleProgressUpdated = event => setState(current => ({
      ...current,
      updateProgress: event.detail.progress
    }))
    const handleLightSensorStatus = event => setState(current => ({
      ...current,
      lightSensorStatus: event.detail,
      linkedLevel: !current.adjustmentActive
        && event.detail?.enabled
        && Number.isFinite(event.detail?.targetBrightness)
          ? event.detail.targetBrightness
          : current.linkedLevel
    }))

    window.addEventListener("monitorsUpdated", handleMonitorsUpdated)
    window.addEventListener("settingsUpdated", handleSettingsUpdated)
    window.addEventListener("localizationUpdated", handleLocalizationUpdated)
    window.addEventListener("updateUpdated", handleUpdateUpdated)
    window.addEventListener("sleepUpdated", handleSleepUpdated)
    window.addEventListener("isRefreshing", handleRefreshingUpdated)
    window.addEventListener("lightSensorStatusUpdated", handleLightSensorStatus)
    if (window.isAppX === false) window.addEventListener("updateProgress", handleProgressUpdated)

    window.requestSettings()
    window.requestMonitors()
    window.ipc.send('request-localization')
    window.reactReady = true

    return () => {
      window.removeEventListener("monitorsUpdated", handleMonitorsUpdated)
      window.removeEventListener("settingsUpdated", handleSettingsUpdated)
      window.removeEventListener("localizationUpdated", handleLocalizationUpdated)
      window.removeEventListener("updateUpdated", handleUpdateUpdated)
      window.removeEventListener("sleepUpdated", handleSleepUpdated)
      window.removeEventListener("isRefreshing", handleRefreshingUpdated)
      window.removeEventListener("lightSensorStatusUpdated", handleLightSensorStatus)
      window.removeEventListener("updateProgress", handleProgressUpdated)
    }
  }, [])

  useEffect(() => {
    const panel = window.document.getElementById("panel")
    if (panel) window.sendHeight(panel.offsetHeight)
  })

  const renderPowerButton = (monitor, monitorFeatures) => {
    const customPower = window.settings?.monitorFeaturesSettings?.[monitor.hwid?.[1]]?.["0xD6"]
    if (!monitorFeatures?.["0xD6"] || (!monitor.features?.["0xD6"] && !customPower)) return null
    const powerOff = () => {
      window.ipc.send("sleep-display", monitor.hwid.join("#"))
      if (monitor.features?.["0xD6"]) {
        monitor.features["0xD6"][0] = monitor.features["0xD6"][0] >= 4
          ? 1
          : window.settings.ddcPowerOffValue
      }
    }
    return (
      <div className="feature-power-icon simple" onClick={powerOff}>
        <span className="icon vfix">&#xE7E8;</span>
        <span>{monitor.features?.["0xD6"]?.[0] >= 4
          ? T.t("PANEL_LABEL_TURN_ON")
          : T.t("PANEL_LABEL_TURN_OFF")}</span>
      </div>
    )
  }

  const renderMonitor = (monitor) => {
    const monitorFeatures = window.settings?.monitorFeatures?.[monitor.hwid?.[1]]
    const rawLevel = Number(monitor.brightnessRaw)
    const outputLevel = Math.round(Number.isFinite(rawLevel)
      ? rawLevel
      : Number(monitor.sdrLevel ?? monitor.brightness ?? 0))
    const showHDRSliders = monitor.type !== "none"
      && (monitor.hdr === "active" || window.settings?.hdrDisplays?.[monitor.key])
      && !window.settings?.sdrAsMainSliderDisplays?.[monitor.key]

    return (
      <div className="monitor-sliders extended" key={monitor.key}>
        <Slider
          name={getMonitorName(monitor, state.names)}
          id={monitor.id}
          level={outputLevel}
          min={0}
          max={100}
          num={monitor.num}
          monitortype={monitor.type}
          hwid={monitor.key}
          onChange={handleMonitorChange}
          afterName={renderPowerButton(monitor, monitorFeatures)}
          scrollAmount={window.settings?.scrollFlyoutAmount}
        />
        <DDCCISliders
          monitor={monitor}
          monitorFeatures={monitorFeatures}
          scrollAmount={window.settings?.scrollFlyoutAmount}
        />
        {showHDRSliders
          ? <HDRSliders monitor={monitor} scrollAmount={window.settings?.scrollFlyoutAmount} />
          : null}
      </div>
    )
  }

  const renderBrightnessControls = () => {
    if (visibleMonitors.length === 0) {
      if (state.isRefreshing) {
        return (
          <div className="no-displays-message" style={{ textAlign: "center", paddingBottom: "15px" }}>
            {T.t("GENERIC_DETECTING_DISPLAYS")}
          </div>
        )
      }
      return <div className="no-displays-message">{T.t("GENERIC_NO_COMPATIBLE_DISPLAYS")}</div>
    }

    return (
      <>
        <div className="linked-level-slider">
          <Slider
            name={T.t("PANEL_BUTTON_LINK_LEVELS")}
            id="linked-level"
            level={state.linkedLevel}
            min={0}
            max={100}
            hwid="linked-level"
            icon={false}
            onChange={handleLinkChange}
            scrollAmount={window.settings?.scrollFlyoutAmount}
          />
        </div>
        <label className="panel-details-row">
          <input
            type="checkbox"
            checked={Boolean(state.showPanelDetails)}
            onChange={event => toggleDetails(event.target.checked)}
          />
          <span>{T.t("PANEL_DETAILS")}</span>
        </label>
        {state.showPanelDetails ? visibleMonitors.map(renderMonitor) : null}
      </>
    )
  }

  const getAutoStatus = () => {
    if (!state.lightSensor?.enabled) return T.t("GENERIC_OFF")
    if (!state.lightSensorStatus?.available) return T.t("PANEL_AUTO_WAITING")
    if (Object.values(state.lightSensorStatus.monitors || {}).some(monitor => monitor.adjusting)) {
      return T.t("PANEL_AUTO_ADJUSTING")
    }
    if (Object.values(state.lightSensorStatus.monitors || {}).some(monitor => monitor.stabilizing)) {
      return T.t("PANEL_AUTO_STABILIZING")
    }
    const lux = state.lightSensorStatus.filteredLux ?? state.lightSensorStatus.currentLux
    return Number.isFinite(lux) ? `${Math.round(lux)} ${T.t("GENERIC_LUX")}` : T.t("GENERIC_ON")
  }

  return (
    <div className="window-base" data-theme={window.settings.theme || "default"} id="panel" data-refreshing={state.isRefreshing}>
      <div className="titlebar">
        <div className="title">{T.t("PANEL_TITLE")}</div>
        <div className="icons">
          {window.settings.sleepAction !== "none"
            ? <div title={T.t("PANEL_BUTTON_TURN_OFF_DISPLAYS")} className="off" onClick={window.turnOffDisplays}>&#xF71D;</div>
            : null}
          <div title={T.t("GENERIC_SETTINGS")} className="settings" onClick={window.openSettings}>&#xE713;</div>
        </div>
      </div>
      <label className="auto-brightness-row">
        <span className="auto-brightness-control">
          <input
            type="checkbox"
            checked={Boolean(state.lightSensor?.enabled)}
            onChange={event => toggleAutoBrightness(event.target.checked)}
          />
          <span>{T.t("PANEL_AUTO_BRIGHTNESS")}</span>
        </span>
        <span className="auto-brightness-status">{getAutoStatus()}</span>
      </label>
      {state.sleeping ? null : renderBrightnessControls()}
      {state.update?.show
        ? <div className="updateBar">
            <div className="left">{T.t("PANEL_UPDATE_AVAILABLE")} ({state.update.version})</div>
            <div className="right">
              <a onClick={window.installUpdate}>{T.t("GENERIC_INSTALL")}</a>
              <a className="icon" title={T.t("GENERIC_DISMISS")} onClick={window.dismissUpdate}>&#xEF2C;</a>
            </div>
          </div>
        : state.update?.downloading
          ? <div className="updateBar">
              <div className="left progress">
                <div className="progress-bar"><div style={{ width: `${state.updateProgress}%` }} /></div>
              </div>
              <div className="right">{state.updateProgress}%</div>
            </div>
          : null}
      <div id="mica">
        <div className="displays" style={{ visibility: window.micaState.visibility }}>
          <div className="blur"><img alt="" src={window.micaState.src} width="2560" height="1440" /></div>
        </div>
        <div className="noise" />
      </div>
    </div>
  )
})

export default BrightnessPanel;
