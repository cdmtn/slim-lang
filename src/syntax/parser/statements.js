import { DECLARATION_WORDS, isLetter, tokenIsIdentifier, tokenIsKeywordOrIdentifier, tt } from "./shared.js"

export const slimStatements = superClass => class extends superClass {
    parseBlockBody(node, allowDirectives, topLevel, end, afterBlockParse) {
        super.parseBlockBody(node, allowDirectives, topLevel, end, afterBlockParse)
        if (topLevel) for (const name of this.slimUseLocals) this.scope.undefinedExports.delete(name)
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

        if (word === "func" && next.type === tt.star) return true
        if (DECLARATION_WORDS.has(word) || word === "type" || word === "state") return tokenIsIdentifier(next.type)
        if (word === "isolated" || word === "element") return this.tokenIsWord(next, "component") || next.type === tt.parenL
        if (word === "async") return this.tokenIsWord(next, "func")
        if (word === "global") return tokenIsIdentifier(next.type)
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
            case "trait":
                if (tokenIsIdentifier(next.type)) return this.parseSlimTrait(this.startNode())
                break
            case "type": {
                const after = this.charAfterSpaces(next.end)
                const isAlias = after === "=" && this.input[this.input.indexOf("=", next.end) + 1] !== "="
                if (tokenIsIdentifier(next.type) && (isAlias || after === "(")) return this.parseSlimType(this.startNode())
                break
            }
            case "func":
                if (tokenIsIdentifier(next.type) || next.type === tt.star) return this.parseSlimFunc(this.startNode(), false)
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
                if (tokenIsIdentifier(next.type) && this.sameLine(next)) return this.parseSlimState(this.startNode())
                break
            case "mode":
                if (next.type === tt.string && this.sameLine(next)) return this.parseSlimMode(this.startNode())
                break
            case "global":
                if (/^global[ \t]+(?:let[ \t]+)?[A-Za-z_$][\w$]*[ \t]*(?:\?|:|,|;|\r?\n|$)/.test(this.input.slice(this.state.start, this.state.start + 200))) {
                    return this.parseSlimGlobal(this.startNode())
                }
                break
        }

        if (tokenIsIdentifier(this.state.type) && next.type === tt.parenL && this.sameLine(next) &&
            this.slimLooksLikeFunctionHeader(next.start)) {
            return this.slimTryShorthandFunction(false)
        }
        return null
    }

    parseSlimGlobal(node) {
        this.next()
        const writable = this.isWord("let")
        if (writable) this.next()
        const declarator = this.startNode()
        const id = this.parseIdentifier()
        const optional = this.eat(tt.question)
        if (!this.match(tt.colon)) this.slimFail(`"${id.name}" needs a type: global ${id.name}: World`)
        id.typeAnnotation = this.tsParseTypeAnnotation()
        this.resetEndLocation(id)
        if (this.match(tt.comma)) this.slimFail(`global takes one name: global ${id.name}: World`)
        if (this.match(tt.eq)) this.slimFail(`global only describes "${id.name}", the host or a script provides its value`)
        declarator.id = id
        declarator.init = null
        node.declarations = [this.finishNode(declarator, "VariableDeclarator")]
        node.kind = writable ? "let" : "const"
        node.declare = true
        this.semicolon()
        const declaration = this.finishNode(node, "VariableDeclaration")
        declaration.slimGlobal = { optional }
        return declaration
    }

    parseSlimState(node) {
        this.next()
        this.parseVar(node, false, "let")
        const declarator = node.declarations[node.declarations.length - 1]
        if (this.match(tt._with) && !this.hasPrecedingLineBreak() && declarator.init) {
            this.next()
            if (!this.isWord("equals")) this.slimFail('Expected "equals(...)" after "with": state name = value with equals((a, b) => a == b)')
            const marker = this.startNode()
            const callee = this.parseIdentifier(true)
            callee.name = "__state_equals__"
            this.expect(tt.parenL)
            marker.callee = callee
            marker.arguments = [this.parseMaybeAssignAllowIn()]
            this.expect(tt.parenR)
            this.finishNode(marker, "CallExpression")
            const sequence = this.startNodeAtNode(declarator.init)
            sequence.expressions = [marker, declarator.init]
            declarator.init = this.finishNode(sequence, "SequenceExpression")
        }
        this.semicolon()
        const declaration = this.finishNode(node, "VariableDeclaration")
        declaration.slimState = true
        return declaration
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
        const tag = next.type === tt.lt && (isLetter(this.input[next.end] ?? "") || this.input[next.end] === ">")
        const interpolation = next.type === tt.name && next.value === "$" && this.input[next.end] === "{"
        if (tag || interpolation) {
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
}
