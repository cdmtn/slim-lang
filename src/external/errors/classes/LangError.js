import { diagnosticDetails } from "../hints.js"
import { parseStack, getSourceLine } from "../location.js"

export class LangError extends Error {
    constructor(message, tag = "Error", meta = {}) {
        super(message)
        this.tag = tag
        this.name = tag
        Object.assign(this, diagnosticDetails({ ...meta, tag, message }))
        if (meta.length !== undefined) this.length = meta.length

        const loc = parseStack(this.stack, meta.skipUserFrames ?? 0)

        this.file = meta.file ?? loc?.file ?? null
        this.line = meta.line ?? loc?.line ?? null
        this.col = meta.col ?? loc?.col ?? null
        this.sourceLine = meta.sourceLine ?? (
            this.file && this.line
                ? getSourceLine(this.file, this.line)
                : null
        )

        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor)
        }
    }
}

