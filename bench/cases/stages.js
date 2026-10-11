// Compiler stages measured one at a time on decls-N fixtures. Inputs of a stage are
// produced in setup (untimed) so each row isolates exactly one stage.
import { guardExit } from "../context.js"

const source = (ctx, size) => ctx.fixture(`decls-${size}`)
const fileOf = (ctx, size) => ctx.fixturePath(`decls-${size}`)
const generator = async ctx => {
    const mod = await import("@babel/generator")
    return mod.default.default ?? mod.default
}

// Parsed AST + the Slim source map, shared by checker/generator setups.
async function frontEnd(ctx, size, text = source(ctx, size)) {
    const { preprocess } = await ctx.src("src/parser.js")
    const { parse } = await import("@babel/parser")
    const file = fileOf(ctx, size)
    const { code: pre, mapped } = preprocess(text, file)
    const ast = parse(pre, { sourceType: "module", plugins: ["jsx"] })
    return { ast, pre, mapped, file, text }
}

export const setups = {
    async "compiler.lexer"(ctx, size) {
        const { tokenize } = await ctx.src("src/lexer.js")
        const text = source(ctx, size)
        return {
            run: () => tokenize(text),
            verify: tokens => {
                if (tokens.length < size) throw new Error(`only ${tokens.length} tokens`)
                if (tokens.at(-1).end > text.length) throw new Error("token past end of input")
            },
            counters: { bytes: text.length }
        }
    },
    async "compiler.preprocess"(ctx, size) {
        const { preprocess } = await ctx.src("src/parser.js")
        const text = source(ctx, size)
        const file = fileOf(ctx, size)
        return {
            run: () => preprocess(text, file),
            verify: r => {
                if (typeof r.code !== "string" || /\bstruct\s+S0\b/.test(r.code)) throw new Error("struct keyword survived preprocess")
            },
            counters: { bytes: text.length }
        }
    },
    async "compiler.parse"(ctx, size) {
        const { pre } = await frontEnd(ctx, size)
        const { parse } = await import("@babel/parser")
        return {
            run: () => parse(pre, { sourceType: "module", plugins: ["jsx"] }),
            verify: ast => { if (ast.program.body.length < size) throw new Error("fewer statements than declarations") },
            counters: { bytes: pre.length }
        }
    },
    async "compiler.check"(ctx, size) {
        const { checkTypes } = await ctx.src("src/checker.js")
        const { ast, mapped, file, text } = await frontEnd(ctx, size)
        return {
            run: () => checkTypes(ast, { mapped, originalCode: text, sourceFile: file }),
            verify: diagnostics => { if (diagnostics.length) throw new Error(`${diagnostics.length} unexpected diagnostics`) }
        }
    },
    // Failure path of the checker: every line is a type error and must be reported.
    async "compiler.check-errors"(ctx, size) {
        const { checkTypes } = await ctx.src("src/checker.js")
        const text = Array.from({ length: size }, (_, i) => `let v${i}: int = "text"`).join("\n")
        const { ast, mapped, file } = await frontEnd(ctx, size, text)
        return {
            run: () => checkTypes(ast, { mapped, originalCode: text, sourceFile: file }),
            verify: diagnostics => { if (diagnostics.length !== size) throw new Error(`expected ${size} diagnostics, got ${diagnostics.length}`) },
            counters: { expected_diagnostics: size }
        }
    },
    // Babel generation of the lowered AST, without a source map.
    async "compiler.generate"(ctx, size) {
        const generate = await generator(ctx)
        const { ast, pre } = await frontEnd(ctx, size)
        return {
            run: () => generate(ast, {}, pre),
            verify: out => { if (!out.code.includes("S0")) throw new Error("generated code lost the first declaration") }
        }
    },
    // Same generation with sourceMaps: the difference to compiler.generate is the map cost.
    async "compiler.sourcemap"(ctx, size) {
        const generate = await generator(ctx)
        const { ast, pre } = await frontEnd(ctx, size)
        return {
            run: () => generate(ast, { sourceMaps: true, sourceFileName: "bench.slim" }, pre),
            verify: out => { if (!out.map?.mappings) throw new Error("empty source map") }
        }
    },
    async "compiler.transform"(ctx, size) { return transformCase(ctx, size, false) },
    async "compiler.transform-check"(ctx, size) { return transformCase(ctx, size, true) },
    async "compiler.format"(ctx, size) {
        const { formatSlim } = await ctx.src("src/format.js")
        const text = source(ctx, size)
        return {
            run: () => formatSlim(text),
            verify: out => {
                if (!out.trim()) throw new Error("empty output")
                if (formatSlim(out) !== out) throw new Error("formatter is not idempotent")
            },
            counters: { bytes: text.length }
        }
    }
}

async function transformCase(ctx, size, check) {
    const { transform } = await ctx.src("src/transform.js")
    const text = source(ctx, size)
    const file = fileOf(ctx, size)
    return {
        run: () => guardExit(() => transform(text, file, { check })),
        verify: ({ code }) => {
            if (!code.includes("__def_struct__")) throw new Error("struct was not lowered")
            if (!code.includes("sourceMappingURL")) throw new Error("no source map comment")
        },
        counters: { bytes_in: text.length }
    }
}
