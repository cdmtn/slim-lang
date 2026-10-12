import { formatError } from "../external/classErrors.js"

function unhandled(err) {
    console.error(formatError(err instanceof Error || err?.message
        ? err : { tag: "Error", message: String(err) }))
    process.exit(1)
}

process.on("unhandledRejection", unhandled)
process.on("uncaughtException", unhandled)
