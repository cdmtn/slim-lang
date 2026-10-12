export function splitType(text, separator = ",") {
    const parts = []
    let depth = 0
    let start = 0
    for (let i = 0; i < text.length; i++) {
        const char = text[i]
        if ("<[(".includes(char)) depth++
        else if (">])".includes(char)) depth--
        else if (char === separator && depth === 0) {
            parts.push(text.slice(start, i).trim())
            start = i + 1
        }
    }
    parts.push(text.slice(start).trim())
    return parts.filter(Boolean)
}
