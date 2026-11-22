import { decodeEntities } from "../external/helpers.js"

export const VOID_TAGS = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr"
])
const RAW_TAGS = new Set(["script", "style", "textarea", "title"])
const UNESCAPED_TAGS = new Set(["script", "style"])

const OPEN = "\u0000"
const CLOSE = "\u0001"

export const holeMark = index => `${OPEN}${index}${CLOSE}`

const isSpace = ch => ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f"
const isLetter = ch => (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z")
const EVENT_MODIFIERS = new Set(["capture", "passive", "once"])
const ATTRIBUTE_PREFIXES = new Set(["bind", "xlink", "xml", "xmlns"])
const isNameChar = ch => isLetter(ch) || (ch >= "0" && ch <= "9") || ch === "-" || ch === "_" || ch === ":" || ch === "."

function splitHoles(text, decode) {
    const parts = []
    let i = 0
    while (i < text.length) {
        const open = text.indexOf(OPEN, i)
        if (open === -1) {
            parts.push(decode ? decodeEntities(text.slice(i)) : text.slice(i))
            break
        }
        if (open > i) parts.push(decode ? decodeEntities(text.slice(i, open)) : text.slice(i, open))
        const close = text.indexOf(CLOSE, open)
        parts.push({ hole: Number(text.slice(open + 1, close)) })
        i = close + 1
    }
    return parts
}

function partsToNodes(parts) {
    return parts.map(part => typeof part === "string" ? { type: "text", value: part } : { type: "hole", index: part.hole })
}

export function parseMarkup(quasis, fail) {
    let src = quasis[0]
    for (let i = 1; i < quasis.length; i++) src += holeMark(i - 1) + quasis[i]

    const root = { type: "fragment", children: [] }
    const stack = [root]
    const top = () => stack[stack.length - 1]
    const len = src.length
    let i = 0

    const readHole = () => {
        const close = src.indexOf(CLOSE, i)
        const index = Number(src.slice(i + 1, close))
        i = close + 1
        return index
    }

    while (i < len) {
        const c = src[i]

        if (c === OPEN) {
            top().children.push({ type: "hole", index: readHole() })
            continue
        }

        if (c !== "<") {
            let end = i
            while (end < len && src[end] !== "<" && src[end] !== OPEN) end++
            top().children.push({ type: "text", value: decodeEntities(src.slice(i, end)) })
            i = end
            continue
        }

        if (src.startsWith("<!--", i)) {
            const close = src.indexOf("-->", i + 4)
            const end = close === -1 ? len : close
            top().children.push({ type: "comment", value: src.slice(i + 4, end) })
            i = close === -1 ? len : close + 3
            continue
        }

        if (src[i + 1] === "!" || src[i + 1] === "?") {
            const close = src.indexOf(">", i)
            i = close === -1 ? len : close + 1
            continue
        }

        if (src[i + 1] === "/") {
            const close = src.indexOf(">", i)
            const end = close === -1 ? len : close
            const name = src.slice(i + 2, end).trim().toLowerCase()
            const dynamic = name.startsWith(OPEN)
            for (let s = stack.length - 1; s >= 1; s--) {
                if (dynamic ? stack[s].dynamic !== undefined : stack[s].tag.toLowerCase() === name) {
                    stack.length = s
                    break
                }
            }
            i = close === -1 ? len : close + 1
            continue
        }

        const dynamicTag = src[i + 1] === OPEN
        if (!dynamicTag && !isLetter(src[i + 1] ?? "")) {
            top().children.push({ type: "text", value: "<" })
            i++
            continue
        }

        let element
        if (dynamicTag) {
            const at = i
            i++
            const dynamic = readHole()
            if (src[i] !== undefined && !isSpace(src[i]) && src[i] !== ">" && src[i] !== "/") fail("A dynamic tag is written <${tag}>, with nothing joined to it")
            element = { type: "element", tag: "slim-dynamic", dynamic, attrs: [], children: [], at }
        } else {
            let j = i + 1
            while (j < len && isNameChar(src[j])) j++
            const tag = src.slice(i + 1, j)
            if (src[j] === OPEN) fail(`A \${...} can't be part of a tag name: <${tag}\${...}>`)
            i = j
            element = { type: "element", tag, attrs: [], children: [], at: i - tag.length - 1 }
        }
        const tag = element.tag
        let selfClosing = false

        while (i < len) {
            while (i < len && isSpace(src[i])) i++
            if (i >= len) break
            if (src[i] === ">") { i++; break }
            if (src[i] === "/" && src[i + 1] === ">") { selfClosing = true; i += 2; break }

            if (src[i] === OPEN) {
                element.attrs.push({ spread: readHole() })
                continue
            }

            const nameStart = i
            while (i < len && !isSpace(src[i]) && src[i] !== "=" && src[i] !== ">" && src[i] !== OPEN &&
                !(src[i] === "/" && src[i + 1] === ">")) i++
            const name = src.slice(nameStart, i)
            if (!name) { i++; continue }
            if (src[i] === OPEN) fail(`A \${...} can't be part of an attribute name: ${name}\${...}`)
            const colon = name.indexOf(":")
            if (colon !== -1 && /^on[A-Z]/.test(name)) {
                const unknown = name.slice(colon + 1).split(":").find(modifier => !EVENT_MODIFIERS.has(modifier))
                if (unknown !== undefined) fail(`Unknown event modifier "${unknown}" in ${name}: use capture, passive or once`)
            } else if (colon !== -1 && !ATTRIBUTE_PREFIXES.has(name.slice(0, colon))) {
                fail(`Unknown attribute "${name}": a name with ":" must start with bind:, xlink:, xml: or xmlns:`)
            }

            let k = i
            while (k < len && isSpace(src[k])) k++
            if (src[k] !== "=") {
                element.attrs.push({ name, value: true, at: nameStart })
                continue
            }
            i = k + 1
            while (i < len && isSpace(src[i])) i++

            const quote = src[i]
            let parts
            let quoted = false
            if (quote === '"' || quote === "'") {
                quoted = true
                const close = src.indexOf(quote, i + 1)
                const end = close === -1 ? len : close
                parts = splitHoles(src.slice(i + 1, end), true)
                i = close === -1 ? len : close + 1
            } else {
                const start = i
                while (i < len && !isSpace(src[i]) && src[i] !== ">" && !(src[i] === "/" && src[i + 1] === ">")) i++
                parts = splitHoles(src.slice(start, i), true)
            }

            const holes = parts.filter(part => typeof part !== "string")
            if (holes.length === 0) {
                element.attrs.push({ name, value: parts.join(""), at: nameStart })
            } else if (/^on[A-Z]/.test(name) && holes.length === 1 && parts.every(part => typeof part !== "string" || part.trim() === "")) {
                const [base, ...modifiers] = name.split(":")
                element.attrs.push({ event: base.slice(2).toLowerCase(), modifiers, hole: holes[0].hole, name: base, at: nameStart })
            } else {
                element.attrs.push({ name, parts, quoted, at: nameStart })
            }
        }

        top().children.push(element)
        const lower = /^[A-Z]/.test(tag) ? "" : tag.toLowerCase()
        if (selfClosing || VOID_TAGS.has(lower)) continue

        if (RAW_TAGS.has(lower)) {
            const lowerSrc = src.toLowerCase()
            let close = i
            let end = len
            let next = len
            while (true) {
                close = lowerSrc.indexOf("</" + lower, close)
                if (close === -1) break
                let k = close + 2 + lower.length
                while (k < len && isSpace(src[k])) k++
                if (src[k] === ">") { end = close; next = k + 1; break }
                close += 2
            }
            const content = src.slice(i, end)
            if (content) element.children.push(...partsToNodes(splitHoles(content, !UNESCAPED_TAGS.has(lower))))
            i = next
            continue
        }

        stack.push(element)
    }

    return root.children
}
