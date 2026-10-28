import { babel } from "./babel.js"

const {
    tt, tokenIsIdentifier, tokenIsKeywordOrIdentifier, tokenCanStartExpression, tokenOperatorPrecedence, functionFlags, ExpressionErrors
} = babel.internals

const LEXICAL = 8201
const FUNCTION_SCOPE = 514

const PREFIX_OPERATORS = new Set(["sizeof", "kindof", "empty", "copyof", "lock"])
const NOT_AN_OPERAND = new Set(["in", "of", "instanceof", "as", "from"])
const DECLARATION_WORDS = new Set(["struct", "enum", "func", "component"])

const VOID_ELEMENTS = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr"
])
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title"])
const STATEMENT_WORDS = ["if", "for", "while", "do", "switch", "return", "const", "let", "var", "throw", "try"]
const UNTERMINATED = new Set(["UnterminatedRegExp", "UnterminatedString", "UnterminatedTemplate", "UnterminatedComment"])

const isLetter = c => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z")
const isTagChar = c => isLetter(c) || (c >= "0" && c <= "9") || c === "-" || c === "_" || c === ":" || c === "."
const isBlank = c => c === " " || c === "\t" || c === "\r" || c === "\n"
const hasLineBreak = text => /[\n\r\u2028\u2029]/.test(text)

function lineColumn(input, pos) {
    let line = 1
    let lineStart = 0
    for (let i = 0; i < pos; i++) {
        if (input[i] === "\n") {
            line++
            lineStart = i + 1
        }
    }
    return { line, column: pos - lineStart }
}

export function slimSyntaxError(input, pos, message) {
    const { line, column } = lineColumn(input, pos)
    const error = new SyntaxError(`${message} (${line}:${column})`)
    error.loc = { line, column, index: pos }
    error.pos = pos
    error.code = "BABEL_PARSER_SYNTAX_ERROR"
    error.reasonCode = "SlimSyntaxError"
    error.slimMessage = message
    return error
}

const slim = superClass => class SlimParser extends superClass {

    isWord(word) {
        return tokenIsKeywordOrIdentifier(this.state.type) && this.state.value === word && !this.state.containsEsc
    }

    tokenIsWord(token, word) {
        return tokenIsKeywordOrIdentifier(token.type) && token.value === word
    }

    expectWord(word) {
        if (!this.isWord(word)) this.slimFail(`Expected "${word}"`)
        this.next()
    }

    slimFail(message, pos = this.state.start) {
        throw slimSyntaxError(this.input, pos, message)
    }

    sameLine(token) {
        return !hasLineBreak(this.input.slice(this.state.end, token.start))
    }

    charAfterSpaces(pos) {
        while (pos < this.input.length && (this.input[pos] === " " || this.input[pos] === "\t")) pos++
        return this.input[pos] ?? ""
    }

    slimParseType() {
        return this.tsInType(() => this.tsParseType())
    }

    slimMoveTo(target) {
        const input = this.input
        for (let i = this.state.pos; i < target; i++) {
            const c = input.charCodeAt(i)
            if (c === 10 || c === 8232 || c === 8233 || (c === 13 && input.charCodeAt(i + 1) !== 10)) {
                this.state.curLine++
                this.state.lineStart = i + 1
            }
        }
        this.state.pos = target
    }

    slimResumeAt(pos) {
        this.slimMoveTo(pos)
        this.state.end = pos
        this.state.endLoc = this.state.curPosition()
        this.next()
    }

    slimLooksLikeFunctionHeader(parenPos) {
        const input = this.input
        let depth = 0
        let i = parenPos
        for (; i < input.length; i++) {
            const c = input[i]
            if (c === '"' || c === "'" || c === "`") {
                i++
                while (i < input.length && input[i] !== c) i += input[i] === "\\" ? 2 : 1
            } else if (c === "(") depth++
            else if (c === ")" && --depth === 0) break
        }
        const next = this.charAfterSpaces(i + 1)
        return next === "{" || next === ":" || (next === "-" && input[input.indexOf("-", i + 1) + 1] === ">")
    }


    parseStatementContent(flags, decorators) {
        return this.parseSlimStatement() ?? super.parseStatementContent(flags, decorators)
    }

    shouldParseExportDeclaration() {
        return this.slimDeclarationAhead() || super.shouldParseExportDeclaration()
    }

    parseExportDeclaration(node) {
        return this.parseSlimStatement() ?? super.parseExportDeclaration(node)
    }

    parseExportDefaultExpression() {
        if (this.match(tt._const) || this.match(tt._var) || this.isWord("let")) {
            return this.parseVarStatement(this.startNode(), this.state.value)
        }
        return super.parseExportDefaultExpression()
    }

    slimDeclarationAhead() {
        if (this.state.containsEsc || !tokenIsKeywordOrIdentifier(this.state.type)) return false
        const word = this.state.value
        const next = this.lookahead()

        if (DECLARATION_WORDS.has(word) || word === "type" || word === "state") return tokenIsIdentifier(next.type)
        if (word === "isolated" || word === "element") return this.tokenIsWord(next, "component") || next.type === tt.parenL
        if (word === "async") return this.tokenIsWord(next, "func")
        return false
    }

    parseSlimStatement() {
        if (this.state.containsEsc || !tokenIsKeywordOrIdentifier(this.state.type)) return null

        const word = this.state.value
        const next = this.lookahead()

        switch (word) {
            case "struct":
                if (tokenIsIdentifier(next.type)) return this.parseSlimStruct(this.startNode())
                break
            case "enum":
                if (tokenIsIdentifier(next.type)) return this.parseSlimEnum(this.startNode())
                break
            case "type": {
                const after = this.charAfterSpaces(next.end)
                const isAlias = after === "=" && this.input[this.input.indexOf("=", next.end) + 1] !== "="
                if (tokenIsIdentifier(next.type) && (isAlias || after === "(")) return this.parseSlimType(this.startNode())
                break
            }
            case "func":
                if (tokenIsIdentifier(next.type)) return this.parseSlimFunc(this.startNode(), false)
                break
            case "async":
                if (this.tokenIsWord(next, "func")) return this.parseSlimFunc(this.startNode(), true)
                if (tokenIsIdentifier(next.type) && this.charAfterSpaces(next.end) === "(" &&
                    this.slimLooksLikeFunctionHeader(this.input.indexOf("(", next.end))) {
                    return this.slimTryShorthandFunction(true)
                }
                break
            case "component":
                if (tokenIsIdentifier(next.type)) return this.parseSlimComponent(this.startNode())
                break
            case "isolated":
            case "element":
                if (this.tokenIsWord(next, "component") || (word === "element" && next.type === tt.parenL)) {
                    return this.slimTry(() => this.parseSlimComponent(this.startNode()))
                }
                break
            case "use":
                if (next.type === tt.string || next.type === tt.at) return this.parseSlimUse(this.startNode())
                if (this.sameLine(next) && (next.type === tt.braceL || next.type === tt.star || tokenIsIdentifier(next.type))) {
                    return this.slimTry(() => this.parseSlimUse(this.startNode()))
                }
                break
            case "lock":
                if (next.type === tt._const) return this.parseSlimLockConst(this.startNode())
                break
            case "state":
                if (tokenIsIdentifier(next.type) && this.sameLine(next)) {
                    const declaration = this.parseVarStatement(this.startNode(), "let")
                    declaration.slimState = true
                    return declaration
                }
                break
            case "mode":
                if (next.type === tt.string && this.sameLine(next)) return this.parseSlimMode(this.startNode())
                break
        }

        if (tokenIsIdentifier(this.state.type) && next.type === tt.parenL && this.sameLine(next) &&
            this.slimLooksLikeFunctionHeader(next.start)) {
            return this.slimTryShorthandFunction(false)
        }
        return null
    }

    slimTry(fn) {
        const result = this.tryParse(fn)
        if (result.error || result.aborted) return null
        return result.node
    }

    slimTryShorthandFunction(isAsync) {
        return this.slimTry(() => {
            const node = this.startNode()
            if (isAsync) this.next()
            const fn = this.parseFunction(node, 1 | (isAsync ? 8 : 0))
            this.addExtra(fn, "slimShorthand", true)
            return fn
        })
    }

    parseSlimFunc(node, isAsync) {
        if (isAsync) this.next()
        this.next()
        const fn = this.parseFunction(node, 1 | (isAsync ? 8 : 0))
        this.addExtra(fn, "slimFunc", true)
        return fn
    }

    parseSlimStruct(node) {
        this.next()
        node.id = this.parseIdentifier()
        this.checkLVal(node.id, { type: "VariableDeclarator" }, LEXICAL)

        node.typeParameters = []
        if (this.eat(tt.lt)) {
            do node.typeParameters.push(this.parseIdentifier())
            while (this.eat(tt.comma))
            this.expect(tt.gt)
        }

        node.superName = this.eat(tt._extends) ? this.parseIdentifier() : null
        node.fields = []
        node.methods = []

        this.expect(tt.braceL)
        while (!this.eat(tt.braceR)) {
            if (this.eat(tt.comma) || this.eat(tt.semi)) continue
            if (this.match(tt.eof)) this.slimFail(`Unclosed struct ${node.id.name}`)
            this.parseSlimStructMember(node)
        }
        return this.finishNode(node, "SlimStructDeclaration")
    }

    parseSlimStructMember(struct) {
        const next = this.lookahead()

        if (tokenIsKeywordOrIdentifier(this.state.type) && next.type === tt.parenL) {
            const method = this.startNode()
            method.key = this.parseIdentifier(true)
            method.computed = false
            method.kind = "method"
            method.method = true
            struct.methods.push(this.parseMethod(method, false, false, false, false, "ObjectMethod"))
            return
        }

        const field = this.startNode()
        field.readonly = false
        if (this.isWord("readonly") && (tokenIsKeywordOrIdentifier(next.type) || next.type === tt.star) &&
            next.type !== tt.colon) {
            this.next()
            field.readonly = true
        }
        field.optional = this.eat(tt.star)
        field.key = this.parseIdentifier(true)
        if (this.eat(tt.question)) field.optional = true
        this.expect(tt.colon)
        field.typeAnnotation = this.slimParseType()
        field.value = this.eat(tt.eq) ? this.parseMaybeAssignAllowIn() : null

        if (!this.match(tt.braceR) && !this.match(tt.comma) && !this.match(tt.semi) && !this.hasPrecedingLineBreak()) {
            this.unexpected()
        }
        struct.fields.push(this.finishNode(field, "SlimStructField"))
    }

    parseSlimEnum(node) {
        this.next()
        node.id = this.parseIdentifier()
        this.checkLVal(node.id, { type: "VariableDeclarator" }, LEXICAL)
        node.members = []

        this.expect(tt.braceL)
        while (!this.eat(tt.braceR)) {
            if (this.eat(tt.comma) || this.eat(tt.semi)) continue
            if (this.match(tt.eof)) this.slimFail(`Unclosed enum ${node.id.name}`)

            const member = this.startNode()
            member.key = this.parseIdentifier(true)
            member.value = this.eat(tt.colon) ? this.parseMaybeAssignAllowIn() : null
            node.members.push(this.finishNode(member, "SlimEnumMember"))
        }
        return this.finishNode(node, "SlimEnumDeclaration")
    }

    parseSlimType(node) {
        this.next()
        node.id = this.parseIdentifier()
        this.checkLVal(node.id, { type: "VariableDeclarator" }, LEXICAL)

        if (this.eat(tt.eq)) {
            if (this.eat(tt._extends)) {
                node.kind = "extends"
                node.typeAnnotation = this.slimParseType()
            } else if (this.eat(tt._typeof)) {
                node.kind = "typeof"
                node.expression = this.parseMaybeAssignAllowIn()
            } else {
                node.kind = "alias"
                node.typeAnnotation = this.slimParseType()
            }
            this.semicolon()
            return this.finishNode(node, "SlimTypeDeclaration")
        }

        node.kind = "validator"
        const fn = this.startNode()
        this.slimPendingExtends = fn
        node.validator = this.parseMethod(fn, false, false, false, false, "ObjectMethod")
        node.superType = fn.slimExtends ?? null
        delete fn.slimExtends
        return this.finishNode(node, "SlimTypeDeclaration")
    }

    parseSlimComponent(node) {
        node.modifier = null
        node.tag = null

        if (this.isWord("isolated") || this.isWord("element")) {
            node.modifier = this.state.value
            this.next()
            if (node.modifier === "element" && this.eat(tt.parenL)) {
                if (!this.match(tt.string)) this.unexpected()
                node.tag = this.state.value
                this.next()
                this.expect(tt.parenR)
            }
        }

        this.expectWord("component")
        node.id = this.parseIdentifier()
        this.checkLVal(node.id, { type: "VariableDeclarator" }, LEXICAL)

        const fn = this.startNode()
        this.initFunction(fn, false)
        this.scope.enter(FUNCTION_SCOPE)
        this.prodParam.enter(functionFlags(false, false))
        node.params = this.parseSlimComponentParams()
        fn.params = []
        this.parseFunctionBody(fn, false, true)
        this.prodParam.exit()
        this.scope.exit()

        node.body = fn.body
        return this.finishNode(node, "SlimComponentDeclaration")
    }

    parseSlimComponentParams() {
        const params = { type: "SlimComponentParams", pattern: false, items: [] }
        this.expect(tt.parenL)

        if (this.eat(tt.braceL)) {
            params.pattern = true
            while (!this.eat(tt.braceR)) {
                params.items.push(this.parseSlimParam())
                if (!this.match(tt.braceR)) this.expect(tt.comma)
            }
        } else if (!this.match(tt.parenR)) {
            params.items.push(this.parseSlimParam())
        }

        this.expect(tt.parenR)
        return params
    }

    parseSlimParam() {
        const param = this.startNode()
        param.name = this.parseIdentifier()
        param.optional = this.eat(tt.question)
        param.typeAnnotation = this.eat(tt.colon) ? this.slimParseType() : null
        param.value = this.eat(tt.eq) ? this.parseMaybeAssignAllowIn() : null
        return this.finishNode(param, "SlimParam")
    }

    slimParseUseSource() {
        if (this.match(tt.string)) {
            const value = this.state.value
            this.next()
            return value
        }
        if (!this.match(tt.at)) return null

        const start = this.state.start
        let end = start + 1
        while (end < this.input.length && /[\w$/.-]/.test(this.input[end])) end++
        if (end === start + 1) this.unexpected()
        this.slimResumeAt(end)
        return this.input.slice(start, end)
    }

    parseSlimUse(node) {
        this.next()
        node.specifier = null
        node.locals = []
        const sourceStart = this.state.start
        let source = this.slimParseUseSource()

        if (source !== null && this.isWord("from")) {
            this.slimFail(`A module name can't be imported as a string: write "use name from ..." instead of "use ${this.input.slice(sourceStart, this.state.lastTokEndLoc.index)} from ..."`, sourceStart)
        }

        if (source === null) {
            const start = this.state.start

            if (this.eat(tt.star)) {
                this.expectWord("as")
                node.locals.push(this.parseIdentifier())
            } else if (this.eat(tt.braceL)) {
                while (!this.eat(tt.braceR)) {
                    let local = this.parseIdentifier(true)
                    if (this.isWord("as")) {
                        this.next()
                        local = this.parseIdentifier()
                    }
                    node.locals.push(local)
                    if (!this.match(tt.braceR)) this.expect(tt.comma)
                }
            } else {
                let local = this.parseIdentifier()
                if (this.isWord("as")) {
                    this.next()
                    local = this.parseIdentifier()
                }
                node.locals.push(local)
            }

            node.specifier = this.input.slice(start, this.state.lastTokEndLoc.index).replace(/\s+/g, " ")
            this.expectWord("from")
            source = this.slimParseUseSource()
            if (source === null) this.slimFail(`Expected a module after "from"`)
        }

        node.source = source
        this.semicolon()
        return this.finishNode(node, "SlimUseDeclaration")
    }

    parseSlimLockConst(node) {
        this.next()
        const declaration = this.parseVarStatement(node, "const")
        for (const declarator of declaration.declarations) {
            if (!declarator.init) continue
            declarator.init = this.slimWrapUnary("lock", declarator.init)
        }
        this.addExtra(declaration, "slimLock", true)
        return declaration
    }

    slimWrapUnary(operator, argument) {
        const node = this.startNodeAtNode(argument)
        node.operator = operator
        node.argument = argument
        return this.finishNodeAt(node, "SlimUnaryExpression", argument.loc.end)
    }

    parseSlimMode(node) {
        this.next()
        node.value = this.state.value
        this.next()
        this.semicolon()
        return this.finishNode(node, "SlimModeStatement")
    }

    parseReturnStatement(node) {
        const next = this.lookahead()
        if (next.type === tt.lt && isLetter(this.input[next.end] ?? "")) {
            this.next()
            node.argument = this.parseExpression()
            this.semicolon()
            return this.finishNode(node, "ReturnStatement")
        }
        return super.parseReturnStatement(node)
    }

    parseIfStatement(node) {
        this.next()
        node.test = this.parseHeaderExpression()
        node.consequent = this.parseStatementOrSloppyAnnexBFunctionDeclaration()

        if (this.eat(tt._else)) {
            node.alternate = this.parseStatementOrSloppyAnnexBFunctionDeclaration()
        } else if (this.isWord("elif") && this.lookahead().type === tt.parenL) {
            const alternate = this.parseIfStatement(this.startNode())
            this.addExtra(alternate, "slimElif", true)
            node.alternate = alternate
        } else {
            node.alternate = null
        }
        return this.finishNode(node, "IfStatement")
    }


    slimAtReturnArrow() {
        return this.match(tt.plusMin) && this.state.value === "-" && this.input[this.state.end] === ">"
    }

    slimParseReturnArrow() {
        this.next()
        this.next()
        const annotation = this.tsParseTypeAnnotation(false)
        this.addExtra(annotation, "slimArrow", true)
        return annotation
    }

    parseFunctionBodyAndFinish(node, type, isMethod = false) {
        if (this.slimPendingExtends === node) {
            this.slimPendingExtends = null
            if (this.eat(tt._extends)) node.slimExtends = this.slimParseType()
        }
        if (this.slimAtReturnArrow()) node.returnType = this.slimParseReturnArrow()
        return super.parseFunctionBodyAndFinish(node, type, isMethod)
    }

    shouldParseArrow(params) {
        if (this.slimAtReturnArrow()) return params.every(expr => this.isAssignable(expr, true))
        return super.shouldParseArrow(params)
    }

    parseArrow(node) {
        if (this.slimAtReturnArrow()) {
            const result = this.tryParse(abort => {
                const returnType = this.slimParseReturnArrow()
                if (this.canInsertSemicolon() || !this.match(tt.arrow)) abort()
                return returnType
            })
            if (result.aborted) return undefined
            if (!result.thrown) {
                if (result.error) this.state = result.failState
                node.returnType = result.node
            }
        }
        return super.parseArrow(node)
    }

    shouldParseAsyncArrow() {
        return this.slimAtReturnArrow() || super.shouldParseAsyncArrow()
    }

    parseAsyncArrowFromCallExpression(node, call) {
        if (this.slimAtReturnArrow()) node.returnType = this.slimParseReturnArrow()
        return super.parseAsyncArrowFromCallExpression(node, call)
    }


    tsParseNonArrayType() {
        if (this.match(tt._function)) {
            const node = this.startNode()
            node.typeName = this.createIdentifier(this.startNode(), "function")
            this.next()
            return this.finishNode(node, "TSTypeReference")
        }
        return super.tsParseNonArrayType()
    }

    tsParseArrayTypeOrHigher() {
        const type = super.tsParseArrayTypeOrHigher()
        if (this.hasPrecedingLineBreak() || !this.match(tt.question)) return type

        const node = this.startNodeAtNode(type)
        this.next()
        node.typeAnnotation = type
        return this.finishNode(node, "SlimNullableType")
    }

    tsParseTypeReference() {
        const reference = super.tsParseTypeReference()
        if (!this.match(tt.colon) || this.input[this.state.start + 1] !== ":") return reference

        this.next()
        this.next()
        const node = this.startNodeAtNode(reference)
        node.enumName = reference
        node.member = this.parseIdentifier(true)
        return this.finishNode(node, "SlimEnumMemberType")
    }


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
        if (!this.sameLine(next) || !tokenCanStartExpression(next.type)) return false
        if (tokenIsKeywordOrIdentifier(next.type) && NOT_AN_OPERAND.has(next.value)) return false
        return true
    }

    parseExprOp(left, leftStartLoc, minPrec) {
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
            return this.parseExprOp(this.finishNode(node, "LogicalExpression"), leftStartLoc, minPrec)
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
            return this.parseExprOp(this.finishNode(node, "SlimBinaryExpression"), leftStartLoc, minPrec)
        }

        if (this.slimAtOldPipeStep()) {
            const method = this.lookahead().value
            this.slimFail(`Pipe steps ("| ${method}(...)") were removed: chain the method instead, ".${method}(...)" on the next line. ` +
                `For a bitwise OR, keep "|" at the end of the line above`)
        }

        return super.parseExprOp(left, leftStartLoc, minPrec)
    }

    slimAtOldPipeStep() {
        if (!this.match(tt.bitwiseOR) || !this.hasPrecedingLineBreak()) return false
        const next = this.lookahead()
        return tokenIsKeywordOrIdentifier(next.type) && this.sameLine(next) && this.charAfterSpaces(next.end) === "("
    }

    slimTryMatch() {
        let committed = false
        const result = this.tryParse(abort => {
            const node = this.startNode()
            this.next()
            this.expect(tt.parenL)
            node.discriminant = this.parseExpression()
            this.expect(tt.parenR)
            if (!this.match(tt.braceL)) abort()

            committed = true
            this.next()
            node.arms = []
            while (!this.eat(tt.braceR)) {
                node.arms.push(this.parseSlimMatchArm())
                if (!this.match(tt.braceR)) this.expect(tt.comma)
            }
            return this.finishNode(node, "SlimMatchExpression")
        })

        if (result.aborted) return null
        if (result.thrown || result.error) {
            if (committed) throw result.error
            return null
        }
        return result.node
    }

    parseSlimMatchArm() {
        const arm = this.startNode()
        arm.pattern = null
        arm.binding = null
        arm.guard = null

        const wildcard = this.state.type === tt.name && this.state.value === "_"
        if (wildcard) {
            this.next()
        } else if (!this.slimTryTypeArm(arm)) {
            this.state.potentialArrowAt = -1
            arm.pattern = this.parseExprOps(null)
        }

        if (this.isWord("when")) {
            this.next()
            if (arm.pattern && arm.pattern.type !== "Identifier") this.slimFail(`"when" needs a name or "_" before it`, arm.pattern.start)
            arm.binding ??= arm.pattern
            arm.pattern = null
            this.state.potentialArrowAt = -1
            arm.guard = this.parseExprOps(null)
        }

        arm.wildcard = wildcard
        this.expect(tt.arrow)
        arm.result = this.parseMaybeAssignAllowIn()
        return this.finishNode(arm, "SlimMatchArm")
    }

    slimTryTypeArm(arm) {
        if (!tokenIsKeywordOrIdentifier(this.state.type)) return false

        const result = this.tryParse(abort => {
            const type = this.slimParseType()
            if (!tokenIsIdentifier(this.state.type) || this.isWord("when")) return abort()
            const binding = this.parseIdentifier()
            if (!this.match(tt.arrow) && !this.isWord("when")) return abort()
            return { type, binding }
        })
        if (result.aborted || result.error || result.thrown) return false

        arm.typeAnnotation = result.node.type
        arm.binding = result.node.binding
        return true
    }


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
        if (this.match(tt.lt)) return isLetter(this.input[this.state.end] ?? "")
        return this.state.type === tt.name && this.state.value === "$" && this.input[this.state.end] === "{"
    }

    slimMarkupContinues(pos) {
        const input = this.input
        while (pos < input.length && isBlank(input[pos])) pos++
        return (input[pos] === "<" && isLetter(input[pos + 1] ?? "")) || (input[pos] === "$" && input[pos + 1] === "{")
    }

    parseSlimMarkup() {
        const node = this.startNode()
        const input = this.input
        const quasis = []
        const expressions = []
        const state = { depth: 0, inTag: false, closing: false, tag: "", quote: null, raw: null }

        let pos = this.state.start
        let chunk = pos
        let done = false

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
                quasis.push(input.slice(chunk, pos))
                this.slimMoveTo(pos + 2)
                this.next()
                expressions.push(this.parseSlimInterpolation(pos))
                pos = chunk = this.state.end
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

            if (c === "<" && input.startsWith("<!--", pos)) {
                const close = input.indexOf("-->", pos + 4)
                if (close === -1) this.slimFail("Unclosed comment in markup", pos)
                pos = close + 3
            } else if (c === "<" && input[pos + 1] === "/") {
                pos += 2
                state.inTag = true
                state.closing = true
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

        quasis.push(input.slice(chunk, pos))
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

babel.registerPlugin("slim", slim)

export function parseSlim(code, sourceFilename = "input.slim", { comments = false } = {}) {
    return babel.parse(code, {
        sourceType: "module",
        sourceFilename,
        attachComment: comments,
        allowReturnOutsideFunction: false,
        plugins: ["typescript", "slim"]
    })
}

export { babel }
