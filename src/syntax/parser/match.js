import { STRUCTURAL_PATTERNS, tokenIsIdentifier, tokenIsKeywordOrIdentifier, tt } from "./shared.js"

export const slimMatch = superClass => class extends superClass {
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
            if (arm.pattern && arm.pattern.type === "Identifier") {
                arm.binding ??= arm.pattern
                arm.pattern = null
            } else if (arm.pattern && !STRUCTURAL_PATTERNS.has(arm.pattern.type)) {
                this.slimFail(`"when" needs a name, a {...}, [...] or Enum.Variant(...) pattern, or "_" before it`, arm.pattern.start)
            }
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
}
