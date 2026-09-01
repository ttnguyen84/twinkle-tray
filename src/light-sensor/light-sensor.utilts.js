const AUTO_BRIGHTNESS_CURVE = [
    { position: 0, brightness: 0 },
    { position: 0.08, brightness: 3 },
    { position: 0.2, brightness: 10 },
    { position: 0.38, brightness: 24 },
    { position: 0.6, brightness: 48 },
    { position: 0.8, brightness: 75 },
    { position: 1, brightness: 100 }
];

const EMPTY_LEARNED_CURVE = AUTO_BRIGHTNESS_CURVE.map(() => 0);

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function clampBrightness(value) {
    return clamp(Math.round(value), 0, 100);
}

function getNormalizedLux(lux, minLux = 50, maxLux = 500) {
    const span = maxLux - minLux;
    if (span <= 0) return 0;
    return clamp((lux - minLux) / span, 0, 1);
}

function interpolateCurve(points, position, valueKey) {
    if (position <= points[0].position) return points[0][valueKey];
    const last = points[points.length - 1];
    if (position >= last.position) return last[valueKey];

    for (let index = 0; index < points.length - 1; index++) {
        const from = points[index];
        const to = points[index + 1];
        if (position > to.position) continue;
        const progress = (position - from.position) / (to.position - from.position);
        return from[valueKey] + ((to[valueKey] - from[valueKey]) * progress);
    }
    return last[valueKey];
}

function normalizeLearnedCurve(adjustments = []) {
    return EMPTY_LEARNED_CURVE.map((_, index) => {
        const value = Number(adjustments[index]);
        return Number.isFinite(value) ? clamp(value, -100, 100) : 0;
    });
}

function getLearnedAdjustment(position, adjustments = []) {
    const normalized = normalizeLearnedCurve(adjustments);
    const points = AUTO_BRIGHTNESS_CURVE.map((point, index) => ({
        position: point.position,
        adjustment: normalized[index]
    }));
    return interpolateCurve(points, position, "adjustment");
}

function getBrightnessFromLux(lux, minLux = 50, maxLux = 500, adjustments = []) {
    const position = getNormalizedLux(lux, minLux, maxLux);
    const baseBrightness = interpolateCurve(AUTO_BRIGHTNESS_CURVE, position, "brightness");
    return clampBrightness(baseBrightness + getLearnedAdjustment(position, adjustments));
}

function learnBrightnessCurve(adjustments, lux, minLux, maxLux, desiredBrightness) {
    const normalized = normalizeLearnedCurve(adjustments);
    const position = getNormalizedLux(lux, minLux, maxLux);
    const currentBrightness = getBrightnessFromLux(lux, minLux, maxLux, normalized);
    const delta = clampBrightness(desiredBrightness) - currentBrightness;
    if (delta === 0) return normalized;

    const levels = AUTO_BRIGHTNESS_CURVE.map((point, index) =>
        clamp(point.brightness + normalized[index], 0, 100));
    let left = 0;
    let right = 0;

    if (position >= 1) {
        left = levels.length - 1;
        right = left;
    } else if (position > 0) {
        for (let index = 0; index < AUTO_BRIGHTNESS_CURVE.length - 1; index++) {
            if (position <= AUTO_BRIGHTNESS_CURVE[index + 1].position) {
                left = index;
                right = index + 1;
                break;
            }
        }
    }

    levels[left] = clamp(levels[left] + delta, 0, 100);
    if (right !== left) levels[right] = clamp(levels[right] + delta, 0, 100);
    if (left > 0) levels[left - 1] = clamp(levels[left - 1] + (delta * 0.35), 0, 100);
    if (right < levels.length - 1) {
        levels[right + 1] = clamp(levels[right + 1] + (delta * 0.35), 0, 100);
    }

    // Preserve a monotonic curve while honoring the user's adjustment locally.
    if (delta > 0) {
        for (let index = 1; index < levels.length; index++) {
            levels[index] = Math.max(levels[index], levels[index - 1]);
        }
    } else {
        for (let index = levels.length - 2; index >= 0; index--) {
            levels[index] = Math.min(levels[index], levels[index + 1]);
        }
    }

    return levels.map((level, index) =>
        Math.round((level - AUTO_BRIGHTNESS_CURVE[index].brightness) * 100) / 100);
}

function getMedianLux(samples = []) {
    const values = samples.filter(Number.isFinite).sort((a, b) => a - b);
    if (values.length === 0) return null;
    const middle = Math.floor(values.length / 2);
    if (values.length % 2) return values[middle];
    return (values[middle - 1] + values[middle]) / 2;
}

function getTargetDeadband(targetBrightness) {
    if (targetBrightness < 20) return 2;
    if (targetBrightness < 60) return 3;
    return 4;
}

function getAdaptiveDelay(deltaPoints, isDimming = false) {
    let delay;
    if (deltaPoints < 2) return Infinity;
    if (deltaPoints < 5) delay = 4000;
    else if (deltaPoints < 10) delay = 3000;
    else if (deltaPoints < 20) delay = 2000;
    else if (deltaPoints < 40) delay = 1000;
    else delay = 500;
    return Math.round(delay * (isDimming ? 1.5 : 1));
}

function getTransitionPlan(deltaPoints, isDimming = false) {
    const fastRatio = deltaPoints < 20 ? 0 : (isDimming ? 0.25 : 0.4);
    const fastRate = isDimming ? 8 : 12;
    const slowRate = isDimming ? 6 : 8;
    const fastDistance = deltaPoints * fastRatio;
    const slowDistance = deltaPoints - fastDistance;

    return {
        fastRatio,
        fastDuration: fastRatio > 0
            ? Math.max(1000, Math.round((fastDistance / fastRate) * 1000))
            : 0,
        slowDuration: Math.max(1500, Math.round((slowDistance / slowRate) * 1000))
    };
}

function getBurstLux(samples, isDimming = false) {
    const values = samples.filter(Number.isFinite).sort((a, b) => a - b);
    if (values.length === 0) return null;
    const percentile = isDimming ? 0.75 : 0.5;
    const index = Math.min(values.length - 1, Math.floor((values.length - 1) * percentile));
    return values[index];
}

/**
 * Compute the daytime lux offset based on current time and sun positions.
 * The offset ramps linearly from 0 → luxOffset over rampMinutes after sunrise,
 * stays at luxOffset during midday, then ramps back down to 0 before sunset.
 *
 * @param {number} now - Date.now() epoch ms
 * @param {object} daytimeBoost - { enabled, luxOffset, rampMinutes, sunriseMs, sunsetMs }
 * @returns {number} lux offset to add (0 when disabled or nighttime)
 */
function getDaytimeLuxOffset(now, daytimeBoost) {
    if (!daytimeBoost?.enabled || !daytimeBoost.luxOffset) return 0;
    const { luxOffset, rampMinutes = 120, sunriseMs, sunsetMs } = daytimeBoost;
    if (!Number.isFinite(sunriseMs) || !Number.isFinite(sunsetMs)
        || sunriseMs >= sunsetMs) return 0;

    const rampMs = Math.max(0, rampMinutes) * 60 * 1000;
    const rampUpEnd = sunriseMs + rampMs;
    const rampDownStart = sunsetMs - rampMs;

    // If ramp periods overlap (very short day), clamp to midpoint
    const midpoint = (sunriseMs + sunsetMs) / 2;
    const effectiveRampUpEnd = Math.min(rampUpEnd, midpoint);
    const effectiveRampDownStart = Math.max(rampDownStart, midpoint);

    if (now < sunriseMs || now > sunsetMs) return 0;
    if (now < effectiveRampUpEnd) {
        const elapsed = now - sunriseMs;
        const duration = effectiveRampUpEnd - sunriseMs;
        return duration > 0 ? luxOffset * (elapsed / duration) : luxOffset;
    }
    if (now > effectiveRampDownStart) {
        const remaining = sunsetMs - now;
        const duration = sunsetMs - effectiveRampDownStart;
        return duration > 0 ? luxOffset * (remaining / duration) : 0;
    }
    return luxOffset;
}

module.exports = {
    AUTO_BRIGHTNESS_CURVE,
    EMPTY_LEARNED_CURVE,
    clampBrightness,
    getAdaptiveDelay,
    getBrightnessFromLux,
    getBurstLux,
    getDaytimeLuxOffset,
    getMedianLux,
    getNormalizedLux,
    getTargetDeadband,
    getTransitionPlan,
    learnBrightnessCurve,
    normalizeLearnedCurve
};
