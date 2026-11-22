import { hasLineBreak, slimSyntaxError, tokenIsKeywordOrIdentifier } from "./shared.js"

export const slimBase = superClass => class extends superClass {
    slimUseLocals = new Set()

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
}
