import { ERROR_CODES, VALID_ERROR_CODES } from "./codes.js"

export function diagnosticDetails(error = {}) {
    const message = String(error.message ?? "")
    const tag = error.tag ?? error.name
    const mismatch = message.match(/(?:expect(?:s|ed)?|must return)\s+(.+?), got (.+?)(?:: |$)/)
    const expected = error.expected ?? mismatch?.[1]?.replace(/^\((.*)\)$/, "$1")
    const got = error.got ?? mismatch?.[2]
    let code = error.code
    if (!VALID_ERROR_CODES.has(code)) {
        if (tag === "StructExpectError") code = ERROR_CODES.MISSING_FIELD
        else if (tag === "StructPassedError") code = ERROR_CODES.UNKNOWN_FIELD
        else if (tag === "SyntaxError") code = ERROR_CODES.SYNTAX
        else if (expected || tag === "TypeError") code = ERROR_CODES.TYPE
        else if (tag === "EnumError" || tag === "StructError") code = ERROR_CODES.DECLARATION
        else code = ERROR_CODES.RUNTIME
    }

    let hint = error.hint ?? null
    if (!hint) {
        if (message.includes("got null[]: []") || (error.emptyArray && expected)) {
            hint = "An empty [] has no inferred element type (null[]). Use Array<T> to accept empty arrays, or supply typed elements."
        } else if (expected === "int" && got === "float") {
            hint = "int requires a whole number. Supply an integer, or use float / number for fractional values."
        } else if (expected === "float" && got === "int") {
            hint = "JavaScript represents 1.0 as int. Use number to accept both int and float."
        } else if (expected?.includes("::")) {
            const member = expected.match(/([\w$]+)::([\w$]+)/)
            if (member) hint = `Use ${member[1]}.${member[2]} itself; a raw enum value is not the member. Use ${member[1]} to accept raw values.`
        } else if (code === ERROR_CODES.MISSING_FIELD) {
            hint = "Supply the field, a parse/new default, or declare *field: Type to allow omission. Type? allows null/undefined but still requires the key."
        } else if (code === ERROR_CODES.UNKNOWN_FIELD) {
            hint = "Check the field spelling; remove extra keys or add them to the struct schema."
        } else if (code === ERROR_CODES.ARGUMENT_COUNT) {
            hint = "Supply the required arguments; omit only optional or defaulted parameters."
        } else if (code === ERROR_CODES.MATCH) {
            hint = "Add the missing enum cases or a _ fallback."
        } else if (code === ERROR_CODES.JSON) {
            hint = "Use valid JSON: double-quoted keys and strings, with no trailing commas."
        }
    }
    return { code, hint }
}

export function withDiagnostic(error, meta = {}) {
    Object.assign(error, meta, diagnosticDetails({ ...meta, tag: error.tag ?? error.name, message: error.message }))
    return error
}
