import { AMBIGUOUS_OPERANDS, NOT_AN_OPERAND, PREFIX_OPERATORS, TRY_ENDS, declaredWords, isBlank, isLetter, tokenCanStartExpression, tokenIsKeywordOrIdentifier, tokenOperatorPrecedence, tt } from "./shared.js"

export const slimOperators = superClass => class extends superClass {
    parseMaybeUnary(refExpressionErrors, sawUnary) {
        if (this.slimAtMarkup()) return this.parseSlimMarkup()

        if (this.slimAtPrefixOperator()) {
            const node = this.startNode()
            node.operator = this.state.value
            this.next()
            node.argument = this.parseMaybeUnary(null, true)
            return this.finishNode(node, "SlimUnaryExpression")
        }

        if (this.isWord("match") && this.lookahead().type === tt.parenL) {
            const match = this.slimTryMatch()
            if (match) return this.parseSubscripts(match, match.loc.start)
        }

        return super.parseMaybeUnary(refExpressionErrors, sawUnary)
    }

    slimAtPrefixOperator() {
        if (this.state.containsEsc || this.state.type !== tt.name || !PREFIX_OPERATORS.has(this.state.value)) return false
        if (!isBlank(this.input[this.state.end] ?? "")) return false

        const next = this.lookahead()
        if (!this.sameLine(next)) return false
        if (tokenIsKeywordOrIdentifier(next.type) && NOT_AN_OPERAND.has(next.value)) return false
        const markup = next.type === tt.lt && isLetter(this.input[next.end] ?? "")
        if (this.getPluginOption("slim", "words")?.includes(this.state.value)) {
            if (!tokenCanStartExpression(next.type) || AMBIGUOUS_OPERANDS.has(next.type)) return false
            return true
        }
        return tokenCanStartExpression(next.type) || next.type === tt.slash || next.type === tt.slashAssign || markup
    }

    checkIdentifier(at, bindingType, strictModeChanged) {
        if (!(bindingType & 64) && PREFIX_OPERATORS.has(at.name)) declaredWords?.add(at.name)
        return super.checkIdentifier(at, bindingType, strictModeChanged)
    }

    registerFunctionStatementId(node) {
        if (node.id && PREFIX_OPERATORS.has(node.id.name)) declaredWords?.add(node.id.name)
        return super.registerFunctionStatementId(node)
    }

    parseExprOp(left, leftStartLoc, minPrec) {
        const tail = this.slimExprTail
        if (tail && tail.left !== left && tail.start === leftStartLoc.index && tail.minPrec === minPrec) {
            this.slimExprTail = null
            return left
        }
        while (true) {
            const step = this.slimExprStep(left, leftStartLoc, minPrec)
            if (step === left) return left
            if (step) {
                left = step
                continue
            }
            const saved = this.slimExprTail
            this.slimExprTail = { left, start: leftStartLoc.index, minPrec }
            let result
            try {
                result = super.parseExprOp(left, leftStartLoc, minPrec)
            } finally {
                this.slimExprTail = saved
            }
            if (result === left) return left
            left = result
        }
    }

    slimExprStep(left, leftStartLoc, minPrec) {
        if (this.match(tt.question) && this.slimAtTryOperator()) {
            const node = this.startNodeAt(leftStartLoc)
            node.argument = left
            this.next()
            return this.finishNode(node, "SlimTryExpression")
        }

        if (!this.state.containsEsc && this.state.type === tt.name && (this.state.value === "and" || this.state.value === "or")) {
            const word = this.state.value
            const op = word === "and" ? tt.logicalAND : tt.logicalOR
            const prec = tokenOperatorPrecedence(op)
            if (prec <= minPrec) return left

            const node = this.startNodeAt(leftStartLoc)
            node.left = left
            node.operator = word === "and" ? "&&" : "||"
            this.addExtra(node, "slimWord", word)
            this.next()
            node.right = this.parseExprOpRightExpr(op, prec)
            return this.finishNode(node, "LogicalExpression")
        }

        if (this.match(tt.tilde) && this.input[this.state.end] === "/") {
            const multiplicative = tokenOperatorPrecedence(tt.slash)
            if (multiplicative + 0.5 <= minPrec) return left

            const node = this.startNodeAt(leftStartLoc)
            node.left = left
            node.operator = "~/"
            this.next()
            this.next()
            const rightStart = this.state.startLoc
            node.right = this.parseExprOp(this.parseMaybeUnaryOrPrivate(), rightStart, multiplicative)
            return this.finishNode(node, "SlimBinaryExpression")
        }

        if (this.match(tt.pipeline)) {
            const prec = tokenOperatorPrecedence(tt.pipeline)
            if (prec <= minPrec) return left

            const node = this.startNodeAt(leftStartLoc)
            node.left = left
            this.next()
            const rightStart = this.state.startLoc
            node.right = this.parseExprOp(this.parseMaybeUnaryOrPrivate(), rightStart, prec)
            return this.finishNode(node, "SlimPipeExpression")
        }

        if (this.slimAtOldPipeStep()) {
            const method = this.lookahead().value
            this.slimFail(`Pipe steps ("| ${method}(...)") were removed: chain the method instead, ".${method}(...)" on the next line. ` +
                `For a bitwise OR, keep "|" at the end of the line above`)
        }

        return null
    }

    slimAtOldPipeStep() {
        if (!this.match(tt.bitwiseOR) || !this.hasPrecedingLineBreak()) return false
        const next = this.lookahead()
        return tokenIsKeywordOrIdentifier(next.type) && this.sameLine(next) && this.charAfterSpaces(next.end) === "("
    }

    slimAtTryOperator() {
        const next = this.lookahead()
        if (next.type === tt.eq) return false
        const afterName = /[\w$]/.test(this.input.slice(0, this.state.start).trimEnd().at(-1) ?? "")
        if (next.type === tt.colon) {
            if (!this.state.maybeInArrowParameters || !afterName) return true
            return !this.slimArrowParamsEnd(this.slimClosingParen(next.end))
        }
        if (this.state.maybeInArrowParameters && (next.type === tt.parenR || next.type === tt.comma)) {
            const close = next.type === tt.parenR ? next.start : this.slimClosingParen(next.end)
            if (close === -1) return true
            return !(afterName && this.slimArrowParamsEnd(close))
        }
        if (TRY_ENDS.has(next.type)) return true
        if (!this.slimColonAfter(next.start)) return true
        const attached = !isBlank(this.input[this.state.start - 1] ?? " ") && isBlank(this.input[this.state.end] ?? "")
        if (attached && next.type === tt.plusMin && isBlank(this.input[next.end] ?? "")) return true

        this.slimTryDecisions ??= new Map()
        const at = this.state.start
        const known = this.slimTryDecisions.get(at)
        if (known !== undefined) return known
        const result = this.tryParse(abort => {
            this.next()
            this.parseMaybeAssignAllowIn()
            this.expect(tt.colon)
            abort()
        })
        const decision = !result.aborted
        this.slimTryDecisions.set(at, decision)
        return decision
    }

    slimArrowParamsEnd(close) {
        if (close === -1) return false
        const after = this.charAfterSpaces(close + 1)
        const rest = this.input.slice(this.input.indexOf(after, close + 1))
        return after === ":" || rest.startsWith("=>") || rest.startsWith("->")
    }

    slimColonAfter(pos) {
        if (this.slimLastColon === undefined) this.slimLastColon = this.input.lastIndexOf(":")
        return this.slimLastColon >= pos
    }

    slimClosingParen(pos) {
        const input = this.input
        let depth = 1
        for (let i = pos; i < input.length; i++) {
            const c = input[i]
            if (c === '"' || c === "'" || c === "`") {
                i++
                while (i < input.length && input[i] !== c) i += input[i] === "\\" ? 2 : 1
            } else if (c === "/" && input[i + 1] === "/") {
                while (i < input.length && input[i] !== "\n") i++
            } else if (c === "/" && input[i + 1] === "*") {
                const end = input.indexOf("*/", i + 2)
                if (end === -1) return -1
                i = end + 1
            } else if (c === "(" || c === "[" || c === "{") depth++
            else if (c === ")" || c === "]" || c === "}") {
                if (--depth === 0) return c === ")" ? i : -1
            }
        }
        return -1
    }
}
