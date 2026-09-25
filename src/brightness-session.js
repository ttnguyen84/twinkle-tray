function clampLevel(value) {
    return Math.max(0, Math.min(100, Number(value) || 0));
}

function median(values) {
    const sorted = values.slice().sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
}

function outputsConverged(outputLevels, tolerance = 2.5) {
    const validLevels = (outputLevels || []).filter(Number.isFinite);
    return validLevels.length > 0
        && Math.max(...validLevels) - Math.min(...validLevels) <= tolerance;
}

function resolveLinkedLevel({
    startLevel,
    previewLevel,
    linkTouched,
    outputLevels,
    individualTouched,
    tolerance = 2.5
}) {
    let linkedLevel = linkTouched ? previewLevel : startLevel;
    const validLevels = (outputLevels || []).filter(Number.isFinite);
    if (individualTouched && outputsConverged(validLevels, tolerance)) {
        linkedLevel = Math.round(median(validLevels));
    }
    return clampLevel(linkedLevel);
}

module.exports = { outputsConverged, resolveLinkedLevel };
