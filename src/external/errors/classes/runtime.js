import { LangError } from "./LangError.js"

export class RuntimeError extends LangError {
    constructor(m, meta) { super(m, "RuntimeError", meta) }
}
