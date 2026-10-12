// JSON.parse remains the authority on syntax. This scanner indexes token spans
// in valid JSON, including escaped/duplicate keys, without another value tree.
export function jsonLocations(text) {
    const spans = new Map()
    let cursor = 0
    const whitespace = () => { while (/[ \t\r\n]/.test(text[cursor] ?? "") && cursor < text.length) cursor++ }
    const invalid = () => {
        const error = new SyntaxError("Invalid JSON")
        error.offset = cursor
        throw error
    }
    const stringEnd = () => {
        if (text[cursor] !== '"') invalid()
        const start = cursor++
        while (cursor < text.length) {
            const char = text[cursor++]
            if (char === "\\") {
                const escape = text[cursor]
                if (escape === "u") {
                    cursor++
                    for (let i = 0; i < 4; i++, cursor++) if (!/[0-9a-f]/i.test(text[cursor] ?? "")) invalid()
                } else {
                    if (!escape || !'"\\/bfnrt'.includes(escape)) invalid()
                    cursor++
                }
            } else if (char === '"') return start
            else if (char.charCodeAt(0) < 32) { cursor--; invalid() }
        }
        invalid()
    }
    const scan = segments => {
        whitespace()
        const start = cursor
        const key = JSON.stringify(segments)
        // Duplicate object keys replace the entire earlier subtree, like JSON.parse.
        if (spans.has(key)) {
            const prefix = key.slice(0, -1) + ","
            for (const prior of spans.keys()) if (prior.startsWith(prefix)) spans.delete(prior)
        }
        if (text[cursor] === "{") {
            cursor++
            whitespace()
            while (text[cursor] !== "}") {
                const keyStart = stringEnd()
                const field = JSON.parse(text.slice(keyStart, cursor))
                whitespace()
                if (text[cursor] !== ":") invalid()
                cursor++ // colon
                scan([...segments, field])
                whitespace()
                if (text[cursor] !== ",") break
                cursor++
                whitespace()
                if (text[cursor] === "}") invalid()
            }
            if (text[cursor] !== "}") invalid()
            cursor++
        } else if (text[cursor] === "[") {
            cursor++
            whitespace()
            let index = 0
            while (text[cursor] !== "]") {
                scan([...segments, index++])
                whitespace()
                if (text[cursor] !== ",") break
                cursor++
                whitespace()
                if (text[cursor] === "]") invalid()
            }
            if (text[cursor] !== "]") invalid()
            cursor++
        } else if (text[cursor] === '"') {
            stringEnd()
        } else {
            const token = text.slice(cursor).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0]
            if (!token) invalid()
            cursor += token.length
        }
        spans.set(key, { offset: start, end: cursor })
    }
    scan([])
    whitespace()
    if (cursor !== text.length) invalid()
    return spans
}

export function jsonPosition(text, offset = 0, end = offset + 1) {
    offset = Math.max(0, Math.min(offset, text.length))
    const start = offset > 0 ? text.lastIndexOf("\n", offset - 1) + 1 : 0
    let stop = text.indexOf("\n", offset)
    if (stop === -1) stop = text.length
    return {
        offset,
        line: text.slice(0, start).split("\n").length,
        col: offset - start + 1,
        length: Math.max(1, Math.min(end, stop) - offset),
        sourceLine: text.slice(start, stop).replace(/\r$/, "")
    }
}

export function jsonSyntaxPosition(text, error) {
    const offset = error.message.match(/position (\d+)/)?.[1]
    if (offset !== undefined) return jsonPosition(text, Number(offset))
    const location = error.message.match(/line (\d+) column (\d+)/)
    if (location) {
        const lines = text.split("\n")
        const start = lines.slice(0, Number(location[1]) - 1).reduce((sum, line) => sum + line.length + 1, 0)
        return jsonPosition(text, start + Number(location[2]) - 1)
    }
    if (/end of JSON/i.test(error.message)) return jsonPosition(text, text.length)
    // Engines sometimes omit offsets from short "not valid JSON" messages.
    // The same token scanner can still locate the first grammar violation.
    try { jsonLocations(text) } catch (error) {
        if (typeof error.offset === "number") return jsonPosition(text, error.offset)
    }
    return {}
}
