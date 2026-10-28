import { formatError } from "../external/classErrors.js"

function report(err) {
    console.error(formatError(
        err?.tag ?? "Error",
        err?.message ?? String(err),
        err?.tag ? err.file ?? null : null,
        err?.tag ? err.line ?? null : null,
        err?.tag ? err.col ?? null : null,
        err?.tag ? err.sourceLine ?? null : null
    ))
    process.exit(1)
}

process.on("unhandledRejection", report)
process.on("uncaughtException", report)
