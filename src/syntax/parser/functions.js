import { tt } from "./shared.js"

export const slimFunctions = superClass => class extends superClass {
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
        if (this.slimTraitMethod === node && !this.match(tt.braceL)) {
            const body = this.startNode()
            body.body = []
            body.directives = []
            node.body = this.finishNode(body, "BlockStatement")
            node.slimSignatureOnly = true
            return this.finishNode(node, type)
        }
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

    tsTryParseGenericAsyncArrowFunction(startLoc) {
        if (!this.match(tt.lt)) return undefined
        const previous = this.state.maybeInArrowParameters
        this.state.maybeInArrowParameters = true
        const node = this.tsTryParseAndCatch(() => {
            const arrow = this.startNodeAt(startLoc)
            arrow.typeParameters = this.tsParseTypeParameters(this.tsParseConstModifier)
            this.parseFunctionParams(arrow)
            arrow.returnType = this.slimAtReturnArrow() ? this.slimParseReturnArrow() : this.tsTryParseTypeOrTypePredicateAnnotation()
            this.expect(tt.arrow)
            return arrow
        })
        this.state.maybeInArrowParameters = previous
        if (!node) return undefined
        return this.parseArrowExpression(node, null, true)
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
}
