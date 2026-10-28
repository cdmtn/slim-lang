
export function log(...args) { console.log(...args) }
export function warn(...args) { console.warn(...args) }
export function error(...args) { console.error(...args) }
export function info(...args) { console.info(...args) }
export function debug(...args) { console.log(...args) }

export function type(obj) {
	if (obj === null) return "null"
	if (obj === undefined) return "undefined"
	if (typeof obj === "number" && Number.isNaN(obj)) return "NaN"

	if (typeof HTMLElement !== "undefined" && obj instanceof HTMLElement) return "element"
	if (obj && typeof obj === "object" && obj.nodeType === 11) return "fragment"

	if (typeof obj === "function" && obj.__type__ === true) return "type"
	if (typeof obj === "function" && obj.__component__ === true) return "component"

	if (Array.isArray(obj)) {
		if (obj.length > 0) {
			const first = type(obj[0])
			if (obj.every(el => type(el) === first)) return first + "[]"
		}
		return "array"
	}

	if (typeof obj === "object") return "object"
	if (typeof obj === "string") return "string"
	if (typeof obj === "number") return Number.isInteger(obj) ? "int" : "float"
	if (typeof obj === "boolean") return "bool"
	if (typeof obj === "function") return /^\s*class\s+/.test(obj.toString()) ? "class" : "function"

	return undefined
}

export const CLIENT_RUNTIME = [log, warn, error, info, debug, type]
