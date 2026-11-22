import { ExpressionErrors, RAW_TEXT_ELEMENTS, STATEMENT_WORDS, UNTERMINATED, VOID_ELEMENTS, isBlank, isLetter, isTagChar, tt } from "./shared.js"

export const slimMarkup = superClass => class extends superClass {
    parseMaybeAssign(refExpressionErrors, afterLeftParse) {
        if (!this.match(tt.lt) || !this.slimAtMarkup() || this.slimLooksGeneric()) {
            return super.parseMaybeAssign(refExpressionErrors, afterLeftParse)
        }
        const startLoc = this.state.startLoc
        const left = this.parseMaybeConditional(refExpressionErrors ?? new ExpressionErrors())
        return afterLeftParse ? afterLeftParse.call(this, left, startLoc) : left
    }

    slimLooksGeneric() {
        const rest = this.input.slice(this.state.end, this.state.end + 200)
        return /^(?:const\s+)?[A-Za-z_$][\w$]*\s*(?:,|extends\b|>\s*\()/.test(rest)
    }

    slimAtMarkup() {
        if (this.match(tt.lt)) return isLetter(this.input[this.state.end] ?? "") || this.input[this.state.end] === ">" || this.input.startsWith("${", this.state.end)
        return this.state.type === tt.name && this.state.value === "$" && this.input[this.state.end] === "{"
    }

    slimMarkupContinues(pos) {
        const input = this.input
        while (pos < input.length && isBlank(input[pos])) pos++
        return (input[pos] === "<" && (isLetter(input[pos + 1] ?? "") || input[pos + 1] === ">" || input.startsWith("${", pos + 1))) || (input[pos] === "$" && input[pos + 1] === "{")
    }

    parseSlimMarkup() {
        const node = this.startNode()
        const input = this.input
        const quasis = []
        const expressions = []
        const state = { depth: 0, inTag: false, closing: false, tag: "", quote: null, raw: null, opening: false }

        let pos = this.state.start
        let chunk = pos
        let carried = ""
        let done = false

        const skip = length => {
            carried += input.slice(chunk, pos)
            pos += length
            chunk = pos
        }
        const takeQuasi = () => {
            quasis.push(carried + input.slice(chunk, pos))
            carried = ""
        }

        const closeTag = () => {
            state.inTag = false
            if (state.closing) state.depth--
            else if (!input.startsWith("/>", pos - 2) && !VOID_ELEMENTS.has(state.tag)) {
                state.depth++
                if (RAW_TEXT_ELEMENTS.has(state.tag)) state.raw = state.tag
            }
            return state.depth <= 0 && !this.slimMarkupContinues(pos)
        }

        while (!done) {
            if (pos >= input.length) this.slimFail("Unclosed markup", node.start)
            const c = input[pos]

            if (c === "$" && input[pos + 1] === "{") {
                takeQuasi()
                this.slimMoveTo(pos + 2)
                this.next()
                expressions.push(this.parseSlimInterpolation(pos))
                pos = chunk = this.state.end
                if (state.opening) {
                    state.opening = false
                    state.inTag = true
                    state.closing = false
                    state.tag = ""
                    continue
                }
                if (state.depth <= 0 && !state.inTag && !this.slimMarkupContinues(pos)) done = true
                continue
            }

            if (state.raw) {
                if (c === "<" && input[pos + 1] === "/" && input.substr(pos + 2, state.raw.length).toLowerCase() === state.raw) state.raw = null
                else pos++
                continue
            }

            if (state.inTag) {
                pos++
                if (state.quote) {
                    if (c === state.quote) state.quote = null
                } else if (c === '"' || c === "'") {
                    state.quote = c
                } else if (c === ">") {
                    done = closeTag()
                }
                continue
            }

            if (c === "<" && input[pos + 1] === ">") {
                skip(2)
                state.depth++
            } else if (c === "<" && input.startsWith("</>", pos)) {
                skip(3)
                state.depth--
                if (state.depth <= 0 && !this.slimMarkupContinues(pos)) done = true
            } else if (c === "<" && input.startsWith("<!--", pos)) {
                const close = input.indexOf("-->", pos + 4)
                if (close === -1) this.slimFail("Unclosed comment in markup", pos)
                pos = close + 3
            } else if (c === "<" && input[pos + 1] === "/") {
                pos += 2
                state.inTag = true
                state.closing = true
            } else if (c === "<" && input.startsWith("${", pos + 1)) {
                pos++
                state.opening = true
            } else if (c === "<" && isLetter(input[pos + 1] ?? "")) {
                const nameStart = ++pos
                while (pos < input.length && isTagChar(input[pos])) pos++
                const tag = input.slice(nameStart, pos)
                state.tag = /^[A-Z]/.test(tag) ? "" : tag.toLowerCase()
                state.inTag = true
                state.closing = false
            } else {
                pos++
            }
        }

        takeQuasi()
        this.slimResumeAt(pos)

        node.quasis = quasis
        node.expressions = expressions
        return this.finishNode(node, "SlimMarkup")
    }

    parseSlimInterpolation(open) {
        if (this.match(tt.braceR)) this.slimFail("Empty ${} in markup: put an expression inside or remove it", open)

        const statement = STATEMENT_WORDS.find(word => this.isWord(word))
        if (statement) {
            this.slimFail(`"${statement}" is a statement and can't go inside \${...}: use a ternary (a ? b : c), match or .map() instead`)
        }

        let expression
        try {
            expression = this.parseExpression()
        } catch (error) {
            if (UNTERMINATED.has(error.reasonCode) || (error.pos ?? 0) >= this.input.length) {
                this.slimFail(`"\${" is not closed: add "}" after the expression`, open)
            }
            if (this.input[error.pos] === "}" && error.reasonCode === "UnexpectedToken") {
                this.slimFail("The expression inside ${...} is incomplete", error.pos)
            }
            throw error
        }

        if (!this.match(tt.braceR)) {
            if (this.match(tt.eof)) this.slimFail(`"\${" is not closed: add "}" after the expression`, open)
            this.slimFail(`Expected "}" to close "\${", got "${this.input.slice(this.state.start, this.state.end)}"`)
        }
        return expression
    }
}
