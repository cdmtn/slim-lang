export function parseValue(value) {
    if (value === "true" || value === "false") return value === "true"
    if (value.trim() !== "" && Number.isFinite(Number(value))) return Number(value)
    return value
}

export function log(...text) {
    console.log(`[SLIM CLI]`, ...text)
}

export function error(...text) {
    console.error(`[SLIM CLI]`, ...text)
}
