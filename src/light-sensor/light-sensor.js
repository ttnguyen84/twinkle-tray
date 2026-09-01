const { YoctoLightSensor } = require('./sensors/yocto-light-sensor');
const { FakeLightSensor } = require('./sensors/fake-light-sensor');
const { WindowsAmbientLightSensor } = require('./sensors/windows-ambient-light-sensor');
const {
    clampBrightness,
    getAdaptiveDelay,
    getBrightnessFromLux,
    getBurstLux,
    getDaytimeLuxOffset,
    getMedianLux,
    getTargetDeadband,
    getTransitionPlan,
    learnBrightnessCurve,
    normalizeLearnedCurve
} = require('./light-sensor.utilts');

const defaultSettings = {
    enabled: false,
    active: "windows",
    sensorPollingInterval: 1,
    minLux: 50,
    maxLux: 500,
    learnedAdjustments: [0, 0, 0, 0, 0, 0, 0],
    daytimeBoost: {
        enabled: false,
        luxOffset: 100,
        rampMinutes: 120,
        sunriseMs: null,
        sunsetMs: null
    },
    sensors: {
        yocto: {
            hubUrl: "user:password@localhost"
        },
        fake: {
            overriddenLux: 50
        },
        windows: {}
    }
};

const MANUAL_PAUSE_MS = 10000;
const FILTER_SAMPLE_COUNT = 3;
const FILTER_RISE_TIME_MS = 1500;
const FILTER_FALL_TIME_MS = 4000;
const BURST_TARGET_DELTA = 50;
const BURST_DURATION_MS = 1000;
const BURST_INTERVAL_MS = 100;
const BURST_COOLDOWN_MS = 2000;
const SHADOW_TARGET_DELTA = 30;
const SHADOW_HOLD_MS = 5000;

function clone(data) {
    return JSON.parse(JSON.stringify(data));
}

class LightSensor {
    constructor() {
        this.sensors = {
            yocto: new YoctoLightSensor(),
            fake: new FakeLightSensor(),
            windows: new WindowsAmbientLightSensor(),
        };
        this.active = null;
        this.settings = clone(defaultSettings);
        this.monitors = {};
        this.monitorStates = {};
        this.ramps = {};
        this.currentLux = null;
        this.filteredLux = null;
        this.recentLuxSamples = [];
        this.lastFilterAt = 0;
        this.rampInterval = null;
        this.burstPromise = null;
        this.burstCooldownUntil = 0;
        this.manualPauseUntil = 0;
        this.manualPauseTimer = null;
        this.manualSessionActive = false;
        this.sendToAllWindows = null;
        this.applyBrightness = null;
        this.notifyMonitors = null;
        this.notifySettings = null;
        this.writeSettings = null;
        this.getUpdateInterval = null;
        this.canApplyBrightness = null;
        this.canControlMonitor = null;
        this.setLinkedLevel = null;
        this.readMonitorBrightness = null;
        this.wakeGraceUntil = 0;
        this.lastWriteAt = 0;
        this.readbackInterval = null;
    }

    async start(settings, monitors, dependencies) {
        const rawApplyBrightness = dependencies.applyBrightness;
        Object.assign(this, dependencies);
        // Wrap applyBrightness to track when the last write occurred,
        // so readback polling can skip reads that would echo our own writes.
        if (rawApplyBrightness) {
            this.applyBrightness = (...args) => {
                this.lastWriteAt = Date.now();
                return rawApplyBrightness(...args);
            };
        }
        this.settings = this._healSettings(settings, this.writeSettings);
        this.monitors = monitors;

        for (const sensor of Object.values(this.sensors)) {
            sensor.initialize(
                this.settings,
                this.sendToAllWindows,
                lux => this.handleReading(lux)
            );
        }

        await this.changeSettings(this.settings);
    }

    async changeSettings(newSettings) {
        const healedSettings = this._healSettings(newSettings, this.writeSettings);
        if (!healedSettings?.active || !this.sensors[healedSettings.active]) {
            console.warn("Light sensor received invalid settings");
            return;
        }

        const previous = this.settings;
        this.settings = healedSettings;
        const desired = healedSettings.enabled ? this.sensors[healedSettings.active] : null;

        if (desired !== this.active) {
            if (this.active) await this._disconnectActive();
            this.currentLux = null;
            this.filteredLux = null;
            this._resetLuxFilter();
            this._resetPendingTargets();
            this._stopRamps();
            this.active = desired;
            if (this.active) {
                await this.active.changeSettings(healedSettings, previous);
                await this.active.connect();
            }
        } else if (this.active) {
            await this.active.changeSettings(healedSettings, previous);
        }

        if (!this.active) {
            this.currentLux = null;
            this.filteredLux = null;
            this._resetLuxFilter();
            this._stopRamps();
            this._stopReadback();
        } else {
            this._startReadback();
            if (this.filteredLux !== null) {
                this._processReading(this.filteredLux);
            }
        }
        this._sendStatus();
    }

    async resume(options = {}) {
        if (!this.active) return null;
        // Suppress readback for 5 seconds after wake to avoid treating
        // stale/default brightness from monitors as a manual adjustment.
        this.wakeGraceUntil = Date.now() + 5000;
        try {
            console.log(`Light Sensor: reconnecting ${this.active.name} after resume`);
            await this.active.reconnect();
            if (options.immediate) return await this.getImmediateTargets();
        } catch (error) {
            console.error(`Error reconnecting ${this.active.name} sensor after resume:`, error);
        }
        return null;
    }

    setMonitors(monitors) {
        const previousMonitors = this.monitors;
        this.monitors = monitors;
        const activeKeys = new Set(Object.values(monitors ?? {}).map(monitor => monitor?.key));
        for (const key of Object.keys(this.monitorStates)) {
            if (!activeKeys.has(key)) {
                delete this.monitorStates[key];
                delete this.ramps[key];
            }
        }
        for (const [key, ramp] of Object.entries(this.ramps)) {
            const monitor = this._findMonitor(key);
            const previousMonitor = Object.values(previousMonitors ?? {})
                .find(candidate => candidate?.key === key);
            if (!monitor || !previousMonitor || monitor.id !== ramp.monitorId) {
                delete this.ramps[key];
            }
        }
        if (Object.keys(this.ramps).length === 0) this._stopRampInterval();
        this._sendStatus();
    }

    isEnabledForMonitor(monitor) {
        return Boolean(this.settings.enabled && this._canControl(monitor));
    }

    pauseManual(duration = MANUAL_PAUSE_MS) {
        const pauseDuration = Math.max(0, Number(duration) || MANUAL_PAUSE_MS);
        this.manualPauseUntil = Math.max(this.manualPauseUntil, Date.now() + pauseDuration);
        this._stopRamps();
        this._scheduleManualResume();
        this._sendStatus();
    }

    setManualSessionActive(active) {
        this.manualSessionActive = Boolean(active);
        if (this.manualSessionActive) this._stopRamps();
        else this._scheduleManualResume();
        this._sendStatus();
    }

    learnLinkLevel(level) {
        const lux = this.filteredLux ?? this.currentLux;
        if (!this.settings.enabled || !Number.isFinite(lux)) return false;
        const learnedAdjustments = learnBrightnessCurve(
            this.settings.learnedAdjustments,
            lux,
            this.settings.minLux,
            this.settings.maxLux,
            clampBrightness(level)
        );
        if (JSON.stringify(learnedAdjustments) === JSON.stringify(this.settings.learnedAdjustments)) return false;
        this.settings = { ...this.settings, learnedAdjustments };
        this._persistSettings();
        this._sendStatus();
        return true;
    }

    setManualBrightness() {
        this.pauseManual();
        return false;
    }

    /**
     * Call when a monitor's brightness was changed externally (OSD buttons,
     * Windows settings, etc.) and the app should treat it as a manual
     * adjustment. This pauses auto-brightness, updates the lux→brightness
     * curve to honour the user's preference, and refreshes the UI.
     * @param {string} monitorKey - The monitor's key identifier
     * @param {number} detectedLevel - The brightness level read from hardware (0-100)
     */
    handleExternalBrightnessChange(monitorKey, detectedLevel) {
        if (!this.settings.enabled || !Number.isFinite(detectedLevel)) return;
        const monitor = this._findMonitor(monitorKey);
        if (!monitor || !this.isEnabledForMonitor(monitor)) return;

        const level = clampBrightness(detectedLevel);
        console.log(`Light Sensor: external brightness change detected on ${monitorKey}: ${level}`);

        // Treat exactly like the user dragged the app slider:
        // pause auto-brightness, learn the preference, notify UI.
        this.pauseManual();
        this.learnLinkLevel(level);
        this.setLinkedLevel?.(level);
        this.notifyMonitors?.();
        this._sendStatus();
    }

    async getImmediateTargets() {
        if (!this.active) return null;
        let samples = Number.isFinite(this.currentLux) ? [this.currentLux] : [];
        if (this.active.sampleBurst) {
            samples = samples.concat(await this.active.sampleBurst(600, BURST_INTERVAL_MS));
        }

        const lux = getBurstLux(samples, false);
        if (!Number.isFinite(lux)) return null;
        this.currentLux = lux;
        this.filteredLux = lux;
        this.recentLuxSamples = [lux];
        this.lastFilterAt = Date.now();
        const targets = this._buildTargets(lux);
        console.log(`Light Sensor: immediate recovery sample ${lux.toFixed(1)} lux for ${Object.keys(targets).length} monitor(s)`);
        this._sendStatus();
        return targets;
    }

    async applyImmediateTargets(targets, options = {}) {
        if (this._isManuallyPaused()) return false;
        let applied = false;
        let linkedLevel = null;
        const writes = [];
        for (const target of Object.values(targets ?? {})) {
            const monitor = this._findMonitor(target.key);
            if (!monitor || !this.isEnabledForMonitor(monitor) || !this._canApply(monitor, options)) continue;

            const state = this._getMonitorState(monitor.key);
            delete this.ramps[monitor.key];
            state.observedTarget = target.targetBrightness;
            state.pendingTarget = target.targetBrightness;
            state.targetBrightness = target.targetBrightness;
            state.stableSince = Date.now();
            state.shadowUntil = 0;
            const write = this.applyBrightness(monitor.id, target.targetBrightness, true);
            if (write?.then) writes.push(write);
            linkedLevel = target.targetBrightness;
            applied = true;
        }

        if (linkedLevel !== null) this.setLinkedLevel?.(linkedLevel);
        if (applied) this.notifyMonitors();
        this._sendStatus();
        if (options.awaitWrites && writes.length) await Promise.allSettled(writes);
        return applied;
    }

    handleReading(lux) {
        if (!Number.isFinite(lux) || lux < 0) {
            this.currentLux = null;
            this.filteredLux = null;
            this._resetLuxFilter();
            this._stopRamps();
            this._sendStatus();
            return;
        }

        this.currentLux = lux;
        this.recentLuxSamples.push(lux);
        this.recentLuxSamples = this.recentLuxSamples.slice(-FILTER_SAMPLE_COUNT);
        const medianLux = getMedianLux(this.recentLuxSamples);
        if (!Number.isFinite(medianLux)) return;

        if (this.filteredLux === null) {
            this.filteredLux = medianLux;
            this.lastFilterAt = Date.now();
            this._processReading(medianLux);
            this._sendStatus();
            return;
        }

        const isDimming = medianLux < this.filteredLux;
        const signalDelta = this._getLargestTargetDelta(this.filteredLux, medianLux);
        if (signalDelta >= BURST_TARGET_DELTA && this.active?.sampleBurst
            && !this.burstPromise && Date.now() >= this.burstCooldownUntil) {
            this._startBurst(medianLux, isDimming, signalDelta);
            this._sendStatus();
            return;
        }

        this._acceptReading(medianLux);
        this._sendStatus();
    }

    _acceptReading(lux) {
        const now = Date.now();
        const elapsed = this.lastFilterAt > 0
            ? Math.max(1, now - this.lastFilterAt)
            : 1000;
        const timeConstant = lux >= this.filteredLux
            ? FILTER_RISE_TIME_MS
            : FILTER_FALL_TIME_MS;
        const weight = this.active?.name === "fake"
            ? 1
            : 1 - Math.exp(-elapsed / timeConstant);
        this.lastFilterAt = now;
        this.filteredLux += (lux - this.filteredLux) * weight;
        this._processReading(this.filteredLux);
    }

    _startBurst(triggerLux, isDimming, signalDelta) {
        const sensor = this.active;
        if (!sensor?.sampleBurst) return;
        const baselineLux = this.filteredLux;
        this.burstPromise = (async () => {
            const samples = [triggerLux, ...await sensor.sampleBurst(BURST_DURATION_MS, BURST_INTERVAL_MS)];
            if (this.active !== sensor) return;
            const acceptedLux = getBurstLux(samples, isDimming);
            if (!Number.isFinite(acceptedLux)) return;

            this.currentLux = acceptedLux;
            this.filteredLux = acceptedLux;
            this.recentLuxSamples = [acceptedLux];
            this.lastFilterAt = Date.now();
            this._processReading(acceptedLux, {
                abruptDimming: isDimming && signalDelta >= SHADOW_TARGET_DELTA
            });
            console.log('Light Sensor burst:', {
                direction: isDimming ? 'down' : 'up',
                baselineLux: Math.round(baselineLux * 10) / 10,
                samples: samples.map(value => Math.round(value * 10) / 10),
                acceptedLux: Math.round(acceptedLux * 10) / 10
            });
        })().catch(error => {
            console.error('Light Sensor burst failed:', error);
            if (this.active === sensor) this._acceptReading(triggerLux);
        }).finally(() => {
            this.burstPromise = null;
            this.burstCooldownUntil = Date.now() + BURST_COOLDOWN_MS;
            this._sendStatus();
        });
    }

    _processReading(lux, options = {}) {
        if (!this.settings.enabled) return;
        const now = Date.now();
        const targets = this._buildTargets(lux);
        const manuallyPaused = this._isManuallyPaused(now);
        let acceptedLinkedLevel = null;

        for (const monitor of this._getEnabledMonitors()) {
            const target = targets[monitor.key];
            if (!target) continue;

            const state = this._getMonitorState(monitor.key);
            const { targetBrightness } = target;
            const deltaPoints = Math.abs(targetBrightness - monitor.brightness);
            const isDimming = targetBrightness < monitor.brightness;
            const targetDeadband = getTargetDeadband(targetBrightness);

            state.observedTarget = targetBrightness;

            if (state.pendingTarget === null
                || Math.abs(targetBrightness - state.pendingTarget) > targetDeadband) {
                const recoveringFromDrop = isDimming && state.pendingTarget !== null
                    && targetBrightness > state.pendingTarget;
                if (!isDimming || deltaPoints < SHADOW_TARGET_DELTA || recoveringFromDrop) {
                    state.shadowUntil = 0;
                } else if (deltaPoints >= SHADOW_TARGET_DELTA
                    && (options.abruptDimming || state.shadowUntil <= now)) {
                    state.shadowUntil = now + SHADOW_HOLD_MS;
                }

                // Only reset the stabilization timer and kill the active ramp
                // when the target genuinely diverged (moved further from current
                // brightness than the old pending target, or changed direction).
                // Small lux jitter that keeps the target in the same neighbourhood
                // should NOT restart the delay or interrupt an in-progress ramp.
                const previousPending = state.pendingTarget;
                const targetDiverged = previousPending === null
                    || Math.abs(targetBrightness - monitor.brightness)
                        > Math.abs(previousPending - monitor.brightness)
                    || (targetBrightness > monitor.brightness) !== (previousPending > monitor.brightness);

                state.pendingTarget = targetBrightness;
                if (targetDiverged) {
                    state.stableSince = now;
                    delete this.ramps[monitor.key];
                }
            } else {
                state.pendingTarget = targetBrightness;
            }

            if (deltaPoints < targetDeadband) {
                state.targetBrightness = targetBrightness;
                state.pendingTarget = targetBrightness;
                state.stableSince = now;
                state.shadowUntil = 0;
                delete this.ramps[monitor.key];
                acceptedLinkedLevel = targetBrightness;
                continue;
            }

            if (manuallyPaused) continue;
            const delay = getAdaptiveDelay(deltaPoints, isDimming);
            if (now < state.shadowUntil || (!options.resume && now - state.stableSince < delay)) continue;

            if (state.targetBrightness !== state.pendingTarget || !this.ramps[monitor.key]) {
                state.targetBrightness = state.pendingTarget;
                this._startRamp(monitor, state.targetBrightness);
                acceptedLinkedLevel = state.targetBrightness;
            }
        }

        if (!manuallyPaused && acceptedLinkedLevel !== null) {
            this.setLinkedLevel?.(acceptedLinkedLevel);
        }
    }

    _buildTargets(lux) {
        const offset = getDaytimeLuxOffset(Date.now(), this.settings.daytimeBoost);
        const effectiveLux = lux + offset;
        const targetBrightness = getBrightnessFromLux(
            effectiveLux,
            this.settings.minLux,
            this.settings.maxLux,
            this.settings.learnedAdjustments
        );
        return Object.fromEntries(this._getEnabledMonitors().map(monitor => [monitor.key, {
                key: monitor.key,
                monitorId: monitor.id,
                targetBrightness
            }]));
    }

    _getEnabledMonitors() {
        return Object.values(this.monitors ?? {})
            .filter(monitor => this.isEnabledForMonitor(monitor));
    }

    _persistSettings() {
        this.writeSettings({ lightSensor: this.settings }, false);
        this.notifySettings?.();
    }

    _getLargestTargetDelta(fromLux, toLux) {
        const fromTarget = getBrightnessFromLux(
            fromLux,
            this.settings.minLux,
            this.settings.maxLux,
            this.settings.learnedAdjustments
        );
        const toTarget = getBrightnessFromLux(
            toLux,
            this.settings.minLux,
            this.settings.maxLux,
            this.settings.learnedAdjustments
        );
        return Math.abs(toTarget - fromTarget);
    }

    _startRamp(monitor, targetBrightness) {
        if (!this._canApply(monitor)) return;
        const startBrightness = monitor.brightness;
        const delta = targetBrightness - startBrightness;
        const deltaPoints = Math.abs(delta);
        if (deltaPoints < 1) {
            // Sub-point delta: apply directly instead of creating a ramp.
            // Without this, _processReading would re-trigger _startRamp
            // every polling cycle because no ramp entry exists.
            if (deltaPoints > 0) {
                this.applyBrightness(monitor.id, clampBrightness(targetBrightness), true);
                this.notifyMonitors();
            }
            return;
        }

        const plan = getTransitionPlan(deltaPoints, delta < 0);
        this.ramps[monitor.key] = {
            monitorId: monitor.id,
            startedAt: Date.now(),
            startBrightness,
            fastTarget: startBrightness + (delta * plan.fastRatio),
            targetBrightness,
            ...plan
        };
        this._ensureRampInterval();
    }

    _ensureRampInterval() {
        if (this.rampInterval || Object.keys(this.ramps).length === 0) return;
        const interval = Math.max(250, Number(this.getUpdateInterval?.()) || 500);
        this.rampInterval = setInterval(() => this._tickRamps(), interval);
    }

    _tickRamps() {
        const now = Date.now();
        let didUpdate = false;

        for (const [key, ramp] of Object.entries(this.ramps)) {
            const monitor = this._findMonitor(key);
            if (!monitor || monitor.id !== ramp.monitorId
                || !this.isEnabledForMonitor(monitor) || !this._canApply(monitor)
                || this._isManuallyPaused(now)) {
                delete this.ramps[key];
                continue;
            }

            const elapsed = now - ramp.startedAt;
            let brightness;
            let done = false;

            if (ramp.fastDuration > 0 && elapsed < ramp.fastDuration) {
                const progress = elapsed / ramp.fastDuration;
                brightness = ramp.startBrightness + ((ramp.fastTarget - ramp.startBrightness) * progress);
            } else {
                const slowElapsed = elapsed - ramp.fastDuration;
                const progress = Math.max(0, Math.min(1, slowElapsed / ramp.slowDuration));
                brightness = ramp.fastTarget + ((ramp.targetBrightness - ramp.fastTarget) * progress);
                done = progress >= 1;
            }

            const nextBrightness = clampBrightness(brightness);
            if (nextBrightness !== Math.round(monitor.brightness)) {
                this.applyBrightness(ramp.monitorId, nextBrightness, false);
                didUpdate = true;
            }
            if (done) delete this.ramps[key];
        }

        if (didUpdate) this.notifyMonitors();
        this._sendStatus();

        if (Object.keys(this.ramps).length === 0) this._stopRampInterval();
    }

    _canApply(monitor, options = {}) {
        return this._canControl(monitor)
            && (!this.canApplyBrightness || this.canApplyBrightness(monitor, options));
    }

    _canControl(monitor) {
        return Boolean(monitor && (!this.canControlMonitor || this.canControlMonitor(monitor)));
    }

    _isManuallyPaused(now = Date.now()) {
        return this.manualSessionActive || now < this.manualPauseUntil;
    }

    _scheduleManualResume() {
        if (this.manualPauseTimer) clearTimeout(this.manualPauseTimer);
        this.manualPauseTimer = null;
        if (this.manualSessionActive) return;
        const remaining = this.manualPauseUntil - Date.now();
        if (remaining > 0) {
            this.manualPauseTimer = setTimeout(() => {
                this.manualPauseTimer = null;
                this._resumeAfterManualPause();
            }, remaining + 20);
            return;
        }
        this._resumeAfterManualPause();
    }

    _resumeAfterManualPause() {
        if (this._isManuallyPaused() || !Number.isFinite(this.filteredLux)) return;
        this._processReading(this.filteredLux, { resume: true });
        this._sendStatus();
    }

    _findMonitor(index) {
        if (typeof index === "string" && index * 1 !== index) {
            const monitorValues = Object.values(this.monitors ?? {});
            const exactMatch = monitorValues.find(monitor => monitor?.id === index || monitor?.key === index);
            if (exactMatch) return exactMatch;

            const prefixMatches = monitorValues.filter(monitor => monitor?.id?.indexOf(index) === 0);
            return prefixMatches.length === 1 ? prefixMatches[0] : undefined;
        }
        return this.monitors[index];
    }

    _getMonitorState(key) {
        if (!this.monitorStates[key]) {
            this.monitorStates[key] = {
                observedTarget: null,
                pendingTarget: null,
                stableSince: 0,
                targetBrightness: null,
                shadowUntil: 0
            };
        }
        return this.monitorStates[key];
    }

    async _disconnectActive() {
        try {
            console.log(`Light Sensor: disconnecting ${this.active.name}`);
            await this.active.disconnect();
        } catch (error) {
            console.error(`Error disconnecting ${this.active.name} sensor:`, error);
        }
    }

    _stopRamps() {
        this.ramps = {};
        this._stopRampInterval();
    }

    _resetPendingTargets() {
        for (const state of Object.values(this.monitorStates)) {
            state.observedTarget = null;
            state.pendingTarget = null;
            state.stableSince = 0;
            state.targetBrightness = null;
            state.shadowUntil = 0;
        }
    }

    _resetLuxFilter() {
        this.recentLuxSamples = [];
        this.lastFilterAt = 0;
    }

    _stopRampInterval() {
        if (this.rampInterval) clearInterval(this.rampInterval);
        this.rampInterval = null;
    }

    _startReadback() {
        if (this.readbackInterval || !this.readMonitorBrightness) return;
        this.readbackInterval = setInterval(() => this._tickReadback(), 10000);
    }

    _stopReadback() {
        if (this.readbackInterval) clearInterval(this.readbackInterval);
        this.readbackInterval = null;
    }

    async _tickReadback() {
        if (!this.active || !this.settings.enabled || !this.readMonitorBrightness) return;
        const now = Date.now();

        // Skip during wake grace period — monitors may report stale defaults.
        if (now < this.wakeGraceUntil) return;

        // Skip if we wrote brightness recently — avoid echoing our own writes.
        if (now < this.lastWriteAt + 1000) return;

        // Skip if we're in a manual pause already or a ramp is running.
        if (this._isManuallyPaused(now) || Object.keys(this.ramps).length > 0) return;

        for (const monitor of this._getEnabledMonitors()) {
            try {
                const snapshot = await this.readMonitorBrightness(monitor.id);
                if (!snapshot || !Number.isFinite(snapshot.brightness)) continue;

                const hardwareRaw = snapshot.brightness;
                const knownRaw = monitor.brightnessRaw;

                // Check if another write happened while we were reading.
                if (Date.now() < this.lastWriteAt + 1000) return;

                if (!Number.isFinite(knownRaw)
                    || Math.abs(hardwareRaw - knownRaw) < 2) continue;

                // Hardware brightness differs from what we last wrote →
                // the user adjusted it externally.
                const normalizedLevel = Number.isFinite(snapshot.normalizedBrightness)
                    ? snapshot.normalizedBrightness
                    : hardwareRaw;
                monitor.brightnessRaw = hardwareRaw;
                monitor.brightness = clampBrightness(normalizedLevel);
                this.handleExternalBrightnessChange(monitor.key, monitor.brightness);
                return; // One detection per tick is enough.
            } catch (error) {
                console.warn(`Light Sensor: readback failed for ${monitor.id}:`, error);
            }
        }
    }

    _sendStatus() {
        this.sendStatus();
    }

    sendStatus(send = this.sendToAllWindows) {
        if (!send) return;
        this.active?.sendStatus?.(send);
        const lux = this.filteredLux ?? this.currentLux;
        const daytimeLuxOffset = getDaytimeLuxOffset(Date.now(), this.settings.daytimeBoost);
        const effectiveLux = Number.isFinite(lux) ? lux + daytimeLuxOffset : null;
        const targetBrightness = effectiveLux !== null
            ? getBrightnessFromLux(
                effectiveLux,
                this.settings.minLux,
                this.settings.maxLux,
                this.settings.learnedAdjustments
            )
            : null;
        const monitorStatus = {};
        for (const monitor of this._getEnabledMonitors()) {
            const state = this._getMonitorState(monitor.key);
            monitorStatus[monitor.key] = {
                targetBrightness,
                adjusting: Boolean(this.ramps[monitor.key]),
                stabilizing: state.pendingTarget !== null
                    && state.targetBrightness !== state.pendingTarget
                    && !this._isManuallyPaused()
            };
        }

        send('light-sensor-status', {
            enabled: Boolean(this.settings.enabled),
            active: this.settings.active,
            currentLux: this.currentLux,
            filteredLux: this.filteredLux,
            daytimeLuxOffset: Math.round(daytimeLuxOffset * 10) / 10,
            targetBrightness,
            available: this.currentLux !== null,
            paused: this._isManuallyPaused(),
            monitors: monitorStatus
        });
    }

    _healSettings(settings, writeSettings) {
        const legacyCurves = Object.values(settings?.monitorSettings || {})
            .map(monitor => monitor?.learnedAdjustments)
            .filter(Array.isArray);
        const migratedCurve = legacyCurves[0] || defaultSettings.learnedAdjustments;
        const healed = {
            enabled: Boolean(settings?.enabled ?? defaultSettings.enabled),
            active: this.sensors[settings?.active] ? settings.active : defaultSettings.active,
            sensorPollingInterval: defaultSettings.sensorPollingInterval,
            minLux: Number(settings?.minLux),
            maxLux: Number(settings?.maxLux),
            learnedAdjustments: normalizeLearnedCurve(settings?.learnedAdjustments ?? migratedCurve),
            daytimeBoost: {
                ...clone(defaultSettings.daytimeBoost),
                ...(settings?.daytimeBoost || {})
            },
            sensors: {
                yocto: {
                    ...clone(defaultSettings.sensors.yocto),
                    ...(settings?.sensors?.yocto || {})
                },
                fake: {
                    ...clone(defaultSettings.sensors.fake),
                    ...(settings?.sensors?.fake || {})
                },
                windows: {
                    ...clone(defaultSettings.sensors.windows),
                    ...(settings?.sensors?.windows || {})
                }
            }
        };

        healed.minLux = Number(healed.minLux);
        healed.maxLux = Number(healed.maxLux);
        if (!Number.isFinite(healed.minLux) || !Number.isFinite(healed.maxLux)
            || healed.maxLux <= healed.minLux) {
            healed.minLux = defaultSettings.minLux;
            healed.maxLux = defaultSettings.maxLux;
        }

        if (JSON.stringify(settings) !== JSON.stringify(healed)) {
            console.log('Light Sensor: healing settings');
            writeSettings?.({ lightSensor: healed }, false);
        }
        return healed;
    }
}

module.exports = { LightSensor, defaultLightSensorSettings: clone(defaultSettings) };
