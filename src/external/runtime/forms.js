import { Signal, __computed__, batch, untrack } from "../reactive.js"
import { __type_label__, __type_matches__ } from "./matching.js"

const FORM_NAMES = new Set(["errors", "valid", "values", "submit", "reset", "submitting", "touched", "setErrors", "checking", "formError"])
const isBlank = value => value === undefined || value === null || value === ""
const isThenable = value => value !== null && typeof value === "object" && typeof value.then === "function"

function emptyValue(label) {
    if (label === "bool") return false
    return ""
}

function rulesOf(validate) {
    if (!validate) return []
    if (typeof validate === "function") return [["invalid", validate]]
    if (Array.isArray(validate)) return validate.map(rule => ["invalid", rule])
    return Object.entries(validate)
}

export function createForm(definition, { initial = {}, messages = {}, fields: settings = {}, validate = null } = {}) {
    if (!definition?.scheme) throw new TypeError("createForm takes a struct: createForm(Signup)")
    const scheme = definition.scheme
    const fields = Object.keys(scheme)
    for (const field of fields) {
        if (FORM_NAMES.has(field)) throw new TypeError(`createForm: the field "${field}" of "${definition.name}" has the name of a form property, rename it`)
    }
    for (const field of Object.keys(settings)) {
        if (!(field in scheme)) throw new TypeError(`createForm: "${definition.name}" has no field "${field}"`)
    }

    const settingOf = field => settings[field] ?? {}
    const rules = Object.fromEntries(fields.map(field => [field, rulesOf(settingOf(field).validate)]))
    const startValue = field => field in initial ? initial[field]
        : field in definition.__defaults__ ? definition.__defaults__[field]()
        : emptyValue(scheme[field].type)
    const values = Object.fromEntries(fields.map(field => [field, new Signal(startValue(field))]))
    const touched = Object.fromEntries(fields.map(field => [field, new Signal(false)]))
    const server = Object.fromEntries(fields.map(field => [field, new Signal(null)]))
    const checked = Object.fromEntries(fields.map(field => [field, new Signal(null)]))
    const checking = Object.fromEntries(fields.map(field => [field, new Signal(false)]))
    const serverForm = new Signal(null)
    const submitted = new Signal(false)
    const submitting = new Signal(false)
    const tokens = Object.fromEntries(fields.map(field => [field, 0]))
    const timers = {}
    const running = {}

    const reader = {}
    for (const field of fields) Object.defineProperty(reader, field, { enumerable: true, get: () => values[field].v })

    const textFor = (field, rule, fallback) => {
        const custom = messages[field]
        if (typeof custom === "string") return custom
        if (custom && typeof custom === "object" && rule in custom) return custom[rule]
        return fallback
    }
    const verdict = (field, rule, result, fallback = rule) => {
        if (result === null || result === undefined || result === true) return null
        if (typeof result === "string") return result
        return textFor(field, rule, fallback)
    }
    const enabled = field => {
        const when = settingOf(field).when
        return !when || !!when(reader)
    }

    const coerce = (field, value) => {
        const { specification } = scheme[field]
        if (typeof value !== "string" || value.trim() === "" || __type_matches__(specification, value)) return value
        const number = Number(value)
        return !Number.isNaN(number) && __type_matches__(specification, number) ? number : value
    }

    const local = Object.fromEntries(fields.map(field => [field, __computed__(() => {
        if (!enabled(field)) return null
        const { specification, optional } = scheme[field]
        const value = values[field].v
        if (isBlank(value)) return optional ? null : textFor(field, "required", "required")
        if (!__type_matches__(specification, value)) {
            const label = __type_label__(specification)
            const custom = messages[field]
            if (custom && typeof custom === "object" && !(label in custom) && "type" in custom) return custom.type
            return textFor(field, label, `expected ${label}`)
        }
        for (const [rule, check] of rules[field]) {
            const result = check(value, reader)
            if (isThenable(result)) throw new TypeError(`createForm: the rule "${rule}" of "${field}" returned a promise, put it in "check"`)
            const message = verdict(field, rule, result)
            if (message !== null) return message
        }
        return null
    })]))

    const whole = __computed__(() => {
        if (!validate) return null
        const result = validate(reader)
        if (result === null || result === undefined || result === true) return null
        if (typeof result === "string") return { form: result, fields: {} }
        if (result === false) return { form: "invalid", fields: {} }
        const own = {}
        let rest = null
        for (const [name, message] of Object.entries(result)) {
            if (!message) continue
            if (name in scheme) own[name] = message
            else rest ??= message
        }
        return { form: rest, fields: own }
    })

    const problems = Object.fromEntries(fields.map(field => [field, __computed__(() => {
        const own = local[field].v
        if (own !== null || !enabled(field)) return own
        const cross = whole.v?.fields[field]
        if (cross) return cross
        const result = checked[field].v
        return result && Object.is(result.value, values[field].v) ? result.message : null
    })]))

    const startCheck = (field, now = false) => {
        const { check, debounce = 0 } = settingOf(field)
        clearTimeout(timers[field]?.timer)
        timers[field]?.resolve()
        timers[field] = null
        const token = ++tokens[field]
        if (!check || untrack(() => local[field].v !== null || !enabled(field))) {
            checking[field].v = false
            return null
        }
        const value = values[field].peek()
        checking[field].v = true
        const settle = message => {
            if (tokens[field] !== token) return
            batch(() => {
                checked[field].v = { value, message }
                checking[field].v = false
            })
        }
        const run = () => Promise.resolve()
            .then(() => untrack(() => check(value, reader)))
            .then(result => settle(verdict(field, "check", result, "invalid")), error => settle(String(error?.message ?? error)))
        if (now || debounce <= 0) return running[field] = run()
        return running[field] = new Promise(resolve => {
            timers[field] = { resolve, timer: setTimeout(() => resolve(run()), debounce) }
        })
    }

    const needsCheck = field => !!settingOf(field).check && untrack(() => {
        if (!enabled(field) || local[field].v !== null) return false
        const result = checked[field].v
        return checking[field].v || !result || !Object.is(result.value, values[field].v)
    })

    const errors = {}
    for (const field of fields) {
        Object.defineProperty(errors, field, {
            enumerable: true,
            get: () => server[field].v ?? (touched[field].v || submitted.v ? problems[field].v : null)
        })
    }

    const valid = __computed__(() => !whole.v?.form && serverForm.v === null &&
        fields.every(field => problems[field].v === null && server[field].v === null))
    const snapshot = () => {
        const data = {}
        for (const field of fields) {
            if (!enabled(field)) continue
            const value = values[field].peek()
            if (!(isBlank(value) && scheme[field].optional)) data[field] = value
        }
        return data
    }
    const clearServer = field => {
        server[field].v = null
        serverForm.v = null
    }

    const form = {
        errors,
        get valid() { return valid.v },
        get values() { return untrack(snapshot) },
        get submitting() { return submitting.v },
        get checking() { return fields.some(field => checking[field].v) },
        get formError() { return serverForm.v ?? (submitted.v ? whole.v?.form ?? null : null) },
        touched: field => touched[field]?.v ?? false,
        setErrors(next = null) {
            batch(() => {
                for (const field of fields) server[field].v = null
                serverForm.v = null
                if (next === null || next === undefined) return
                if (typeof next === "string") {
                    serverForm.v = next
                    return
                }
                for (const [name, message] of Object.entries(next)) {
                    if (name in server) server[name].v = message || null
                    else if (message) serverForm.v = message
                }
            })
        },
        submit(handler) {
            const finish = () => {
                if (!valid.peek()) return
                return handler(definition.new(untrack(snapshot)))
            }
            const settleChecks = async () => {
                for (let round = 0; round < 10; round++) {
                    const waits = fields.filter(needsCheck).map(field => startCheck(field, true))
                    if (waits.length === 0) return
                    await Promise.all(waits)
                }
            }
            return event => {
                event?.preventDefault?.()
                batch(() => {
                    submitted.v = true
                    serverForm.v = null
                })
                if (!fields.some(needsCheck)) {
                    const result = finish()
                    if (isThenable(result)) {
                        submitting.v = true
                        return result.finally(() => { submitting.v = false })
                    }
                    return result
                }
                submitting.v = true
                return settleChecks().then(finish).finally(() => { submitting.v = false })
            }
        },
        reset(next = {}) {
            batch(() => {
                for (const field of fields) {
                    clearTimeout(timers[field]?.timer)
                    timers[field]?.resolve()
                    timers[field] = null
                    tokens[field]++
                    values[field].v = field in next ? next[field] : startValue(field)
                    touched[field].v = false
                    server[field].v = null
                    checked[field].v = null
                    checking[field].v = false
                }
                serverForm.v = null
                submitted.v = false
            })
        }
    }
    for (const field of fields) {
        Object.defineProperty(form, field, {
            enumerable: true,
            get: () => values[field].v,
            set: value => {
                batch(() => {
                    values[field].v = coerce(field, value)
                    touched[field].v = true
                    clearServer(field)
                })
                startCheck(field)
            }
        })
    }
    return form
}
