import { LangError } from "./LangError.js"

export class StructError extends LangError {
    constructor(m, meta) { super(m, "StructError", meta) }
}
export class StructPassedError extends LangError {
    constructor(m, meta) { super(m, "StructPassedError", meta) }
}
export class StructExpectError extends LangError {
    constructor(m, meta) { super(m, "StructExpectError", meta) }
}
export class StructResultError extends StructError {
    constructor(m, meta) { super(m, meta) }
}

