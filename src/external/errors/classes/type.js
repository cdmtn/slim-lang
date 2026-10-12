import { LangError } from "./LangError.js"

export class TypeError_ extends LangError {
    constructor(m, meta) { super(m, "TypeError", meta) }
}
export class ArgumentDeclarationTypeError extends TypeError_ {
    constructor(m, meta) { super(m, meta) }
}

