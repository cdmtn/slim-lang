const LOOPS = new Set(["WhileStatement", "DoWhileStatement", "ForStatement", "ForInStatement", "ForOfStatement"])

function endless(node) {
    if (node.type === "ForStatement") return !node.test || (node.test.type === "BooleanLiteral" && node.test.value)
    if (node.type === "WhileStatement" || node.type === "DoWhileStatement") return node.test.type === "BooleanLiteral" && node.test.value
    return false
}

function walkList(statements, frames, options) {
    for (const statement of statements) {
        if (!walk(statement, frames, options)) return false
    }
    return true
}

function walk(node, frames, options) {
    if (!node) return true
    switch (node.type) {
        case "BlockStatement":
            return walkList(node.body, frames, options)
        case "ReturnStatement":
        case "ThrowStatement":
            return false
        case "ContinueStatement": {
            const index = node.label
                ? frames.findLastIndex(entry => entry.label === node.label.name) + 1
                : frames.findLastIndex(entry => entry.loop)
            if (index >= 0 && frames[index]?.loop) frames[index].continued = true
            return false
        }
        case "BreakStatement": {
            const frame = node.label
                ? frames.findLast(entry => entry.label === node.label.name)
                : frames.findLast(entry => entry.breakable)
            if (frame) frame.broken = true
            return false
        }
        case "IfStatement": {
            const consequent = walk(node.consequent, frames, options)
            const alternate = node.alternate ? walk(node.alternate, frames, options) : true
            return consequent || alternate
        }
        case "LabeledStatement": {
            const frame = { label: node.label.name, broken: false }
            frames.push(frame)
            const completes = walk(node.body, frames, options)
            frames.pop()
            return completes || frame.broken
        }
        case "SwitchStatement": {
            const frame = { breakable: true, broken: false }
            frames.push(frame)
            let last = true
            for (const entry of node.cases) last = walkList(entry.consequent, frames, options)
            frames.pop()
            const covered = node.cases.some(entry => !entry.test) || !!options.exhaustive?.(node)
            return frame.broken || !covered || last
        }
        case "TryStatement": {
            const block = walk(node.block, frames, options)
            const handler = node.handler ? walk(node.handler.body, frames, options) : false
            if (node.finalizer && !walk(node.finalizer, frames, options)) return false
            return block || handler
        }
        case "ExpressionStatement":
            return !options.never?.(node.expression)
        default:
            if (LOOPS.has(node.type)) {
                const frame = { breakable: true, broken: false, loop: true, continued: false }
                frames.push(frame)
                const body = walk(node.body, frames, options)
                frames.pop()
                if (endless(node)) return frame.broken
                if (node.type === "DoWhileStatement") return body || frame.broken || frame.continued
                return true
            }
            return true
    }
}

export function completesNormally(statement, options = {}) {
    return walk(statement, [], options)
}
