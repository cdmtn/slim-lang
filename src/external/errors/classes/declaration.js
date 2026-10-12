import { LangError } from "./LangError.js"

export class EnumError extends LangError {
    constructor(m, meta) { super(m, "EnumError", meta) }
}

export class UseError extends Error {
    constructor(m, meta) { super(m, "UseError", meta) }
}

export class TypeDefError extends TypeError {
    constructor(m, meta) { super(m, "TypeDefError", meta) }
}
