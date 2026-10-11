import { tokenize } from "./lexer.js"

export const RESULT_TRY = "__slim_result_try__"

// At this point Slim annotations have already become string literals. Pair
// conditional ?/: within each delimiter group; remaining ? tokens are postfix.
// ?. stays a distinct token. ?? keeps its JS meaning when followed by an
// operand; at an expression boundary it can spell two postfix propagations.
export function operatorSyntaxEdits(code) {
    const tokens = tokenize(code).filter(t => !["ws", "newline", "comment", "template"].includes(t.type))
    const groups = [[]]
    const allGroups = [groups[0]]
    const edits = []
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]
        if (token.value === "await" && tokens[i - 1]?.value === "|>") {
            // Babel's minimal pipeline grammar excludes bare await. A marked
            // unary expression carries it to the AST pass, without moving text.
            edits.push({ start: token.start, end: token.end, replacement: "void ", pipeAwait: true })
        }
        if (["(", "[", "{", "${"].includes(token.value)) {
            groups.at(-1).push(token)
            const group = []
            groups.push(group)
            allGroups.push(group)
        } else if ([")", "]", "}"].includes(token.value) && groups.length > 1) {
            groups.pop()
            groups.at(-1).push(token)
        } else groups.at(-1).push(token)
    }
    for (const group of allGroups) {
        let colons = 0
        for (let i = group.length - 1; i >= 0; i--) {
            const token = group[i]
            if ([";", ","].includes(token.value)) colons = 0
            else if (token.value === ":") colons++
            else if (token.value === "?" || token.value === "??") {
                const next = group[i + 1]
                const startsOperand = next && (next.type !== "punct" ||
                    ["(", "[", "{", "`", "+", "-", "!", "~", "++", "--"].includes(next.value))
                if (token.value === "??" && startsOperand) continue
                if (token.value === "?" && colons > 0 && startsOperand) colons--
                else edits.push({ start: token.start, end: token.end,
                    replacement: ` .${RESULT_TRY}()`.repeat(token.value.length) })
            }
        }
    }
    return edits
}
