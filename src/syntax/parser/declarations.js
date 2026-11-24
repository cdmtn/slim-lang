import { FUNCTION_SCOPE, LEXICAL, functionFlags, tokenIsKeywordOrIdentifier, tt } from "./shared.js"

export const slimDeclarations = superClass => class extends superClass {
    parseSlimStruct(node) {
        this.next()
        node.id = this.parseIdentifier()
        this.checkLVal(node.id, { type: "VariableDeclarator" }, LEXICAL)

        node.typeParameters = this.slimParseTypeParams()
        node.superName = this.eat(tt._extends) ? this.parseIdentifier() : null
        node.implements = this.slimParseImplements()
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

    slimParseTypeParams() {
        const params = []
        if (!this.eat(tt.lt)) return params
        do {
            const param = this.parseIdentifier()
            if (this.eat(tt._extends)) param.constraint = this.slimParseType()
            if (this.eat(tt.eq)) param.default = this.slimParseType()
            params.push(param)
        } while (this.eat(tt.comma))
        this.expect(tt.gt)
        return params
    }

    slimParseImplements() {
        const traits = []
        if (!this.isWord("implements")) return traits
        this.next()
        do traits.push(this.slimParseType())
        while (this.eat(tt.comma))
        return traits
    }

    slimMethodAhead(parenPos) {
        const input = this.input
        let depth = 0
        let i = parenPos
        for (; i < input.length; i++) {
            if (input[i] === "(") depth++
            else if (input[i] === ")" && --depth === 0) break
        }
        const after = this.charAfterSpaces(i + 1)
        return after === "{" || (after === "-" && input[input.indexOf("-", i + 1) + 1] === ">")
    }

    parseSlimTrait(node) {
        this.next()
        node.id = this.parseIdentifier()
        this.checkLVal(node.id, { type: "VariableDeclarator" }, LEXICAL)
        node.typeParameters = this.slimParseTypeParams()
        node.fields = []
        node.methods = []

        this.expect(tt.braceL)
        while (!this.eat(tt.braceR)) {
            if (this.eat(tt.comma) || this.eat(tt.semi)) continue
            if (this.match(tt.eof)) this.slimFail(`Unclosed trait ${node.id.name}`)
            this.parseSlimStructMember(node, true)
        }
        return this.finishNode(node, "SlimTraitDeclaration")
    }

    parseSlimStructMember(struct, trait = false) {
        const next = this.lookahead()

        if (tokenIsKeywordOrIdentifier(this.state.type) && (next.type === tt.parenL || next.type === tt.lt)) {
            const method = this.startNode()
            method.key = this.parseIdentifier(true)
            method.computed = false
            method.kind = "method"
            method.method = true
            if (trait) this.slimTraitMethod = method
            struct.methods.push(this.parseMethod(method, false, false, false, false, "ObjectMethod"))
            this.slimTraitMethod = null
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
        node.methods = []
        node.typeParameters = this.slimParseTypeParams()
        node.implements = this.slimParseImplements()

        this.expect(tt.braceL)
        while (!this.eat(tt.braceR)) {
            if (this.eat(tt.comma) || this.eat(tt.semi)) continue
            if (this.match(tt.eof)) this.slimFail(`Unclosed enum ${node.id.name}`)

            const next = this.lookahead()
            if (tokenIsKeywordOrIdentifier(this.state.type) && (next.type === tt.lt || (next.type === tt.parenL && this.slimMethodAhead(next.start)))) {
                this.parseSlimStructMember(node)
                continue
            }

            const member = this.startNode()
            member.key = this.parseIdentifier(true)
            member.fields = null
            if (this.eat(tt.parenL)) {
                member.fields = []
                while (!this.eat(tt.parenR)) {
                    const field = this.startNode()
                    field.key = this.parseIdentifier(true)
                    this.expect(tt.colon)
                    field.typeAnnotation = this.slimParseType()
                    member.fields.push(this.finishNode(field, "SlimVariantField"))
                    if (!this.match(tt.parenR)) this.expect(tt.comma)
                }
            }
            member.value = this.eat(tt.colon) ? this.parseMaybeAssignAllowIn() : null
            node.members.push(this.finishNode(member, "SlimEnumMember"))
        }
        return this.finishNode(node, "SlimEnumDeclaration")
    }

    parseSlimType(node) {
        this.next()
        if (this.isWord("enum")) this.slimFail(`"enum" is a reserved word and can't name a type — "enum" already is one: it accepts any enum or enum member`)
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
        const [param] = node.validator.params
        if (param?.typeAnnotation) {
            if (node.superType) {
                this.slimFail(`Type "${node.id.name}" names the type of its value twice: keep either "(${param.name ?? "value"}: ...)" or "extends ..."`, param.start)
            }
            node.superType = param.typeAnnotation.typeAnnotation
            delete param.typeAnnotation
        }
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
            const named = []
            const alias = imported => {
                let local = imported
                if (this.isWord("as")) {
                    this.next()
                    local = this.parseIdentifier()
                }
                node.locals.push(local)
                named.push(local === imported ? imported.name : `${imported.name} as ${local.name}`)
            }

            if (this.eat(tt.star)) {
                this.expectWord("as")
                const local = this.parseIdentifier()
                node.locals.push(local)
                node.specifier = `* as ${local.name}`
            } else if (this.eat(tt.braceL)) {
                while (!this.eat(tt.braceR)) {
                    alias(this.parseIdentifier(true))
                    if (!this.match(tt.braceR)) this.expect(tt.comma)
                }
                node.specifier = `{ ${named.join(", ")} }`
            } else {
                alias(this.parseIdentifier())
                node.specifier = named[0]
            }

            this.expectWord("from")
            source = this.slimParseUseSource()
            if (source === null) this.slimFail(`Expected a module after "from"`)
        }

        node.source = source
        for (const local of node.locals) this.slimUseLocals.add(local.name)
        this.semicolon()
        return this.finishNode(node, "SlimUseDeclaration")
    }
}
