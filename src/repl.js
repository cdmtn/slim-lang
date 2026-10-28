import repl from "node:repl"
import vm from "node:vm"
import { preprocess } from "./syntax/index.js"
import "./external/defaults.js"

function slimEval(cmd, context, filename, callback) {
    const source = cmd.trim()
    if (!source) return callback(null, undefined)

    let code
    try {
        code = preprocess(source, "repl").code
    } catch (err) {
        return callback(err)
    }

    code = code.replace(/^\s*(?:let|const)\s+/, "var ")

    try {
        callback(null, vm.runInThisContext(code))
    } catch (err) {
        if (err instanceof SyntaxError && /\b(Unexpected end|Unterminated)\b/.test(err.message)) {
            return callback(new repl.Recoverable(err))
        }
        callback(err)
    }
}

export function startRepl() {
    console.log("Slim REPL — type .exit to quit")
    repl.start({ prompt: "slim> ", eval: slimEval, useGlobal: true, ignoreUndefined: true })
}
