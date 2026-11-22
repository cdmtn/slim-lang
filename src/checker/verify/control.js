import * as t from "@babel/types"
import { ANY, genericOf, unionOf } from "../../external/typeSyntax.js"
import { didYouMean } from "../../suggest.js"
import { knownGlobal } from "../globals.js"
import { UNDEFINED, accepts, atoms, describe, isNamed, isNever, isOpen, single, sourceText, widen } from "../core.js"
import { completesNormally } from "../flow.js"
import { asyncResult, callType, infer, missingCases, tryTarget } from "../infer.js"
import { VARIANT_SHORTHANDS } from "./types.js"
import { overlaps } from "./operators.js"

export function checkExhaustive(node, match, path_, env, report) {
    if (match.wildcard) return

    const result = missingCases(match, path_, env)
    if (!result || result.missing.length === 0) return

    const { subject, missing } = result
    report(node, `match on ${subject} does not handle ${missing.join(", ")}` +
        ` — add the missing case${missing.length === 1 ? "" : "s"} or a "_" fallback`)
}

function switchMatch(node) {
    return { scrutinee: node.discriminant, covered: node.cases.map(entry => entry.test).filter(Boolean), shapes: [], types: [], guarded: false }
}

function flowOptions(path_, env, gaps = []) {
    let paths = null
    const pathOf = node => {
        if (!paths) {
            paths = new Map()
            path_.traverse({
                Function(inner) { inner.skip() },
                enter(inner) { paths.set(inner.node, inner) }
            })
        }
        return paths.get(node) ?? path_
    }
    return {
        never: expression => {
            if (!t.isCallExpression(expression)) return false
            const result = callType(expression, pathOf(expression), env)
            return !!result && isNever(result)
        },
        exhaustive: node => {
            const result = missingCases(switchMatch(node), pathOf(node), env)
            if (!result) return false
            if (result.missing.length > 0) gaps.push(result)
            return result.missing.length === 0
        }
    }
}

export function returnTarget(fn, declared, env) {
    return fn.async ? asyncResult(declared.type, env) : declared.type
}

export function checkFunctionEnd(path_, env, report) {
    const declared = env.returns.get(path_.node)
    if (!declared || !t.isBlockStatement(path_.node.body) || path_.node.generator || path_.node._slimSignatureOnly) return
    const never = isNever(declared.type)
    if (!never && accepts(returnTarget(path_.node, declared, env), UNDEFINED, env)) return
    const gaps = []
    if (!completesNormally(path_.node.body, flowOptions(path_.get("body"), env, gaps))) return
    if (never) {
        report(path_.node, `"${declared.name}" is declared -> never, but it can finish normally: end it with throw`)
        return
    }
    const gap = gaps.at(-1)
    const hint = gap ? ` — the switch on ${gap.subject} does not handle ${gap.missing.join(", ")}` : ""
    report(path_.node, `"${declared.name}" must return ${describe(returnTarget(path_.node, declared, env))}, but it can reach the end without a return${hint}`)
}

export function checkTry(node, path_, env, report) {
    const type = infer(node.arguments[0], path_, env)
    if (!type) return
    const target = tryTarget(type, env)
    if (!target) {
        const promised = single(type, env)
        const awaited = promised?.kind === "generic" && promised.name === "Promise" && promised.args[0] && tryTarget(promised.args[0], env)
        const text = sourceText(node.arguments[0])
        const hint = awaited ? ` — await it first: ${text ? `(await ${text})?` : "(await ...)?"}` : ""
        if (!atoms(type, env).some(atom => isOpen(atom, env))) report(node, `"?" needs a Result or an Option, got ${describe(widen(type))}${hint}`)
        return
    }
    const fn = path_.getFunctionParent()
    const declared = fn && env.returns.get(fn.node)
    if (!declared) return
    const returned = target.name === "Result" ? genericOf("Result", [ANY, target.kind === "generic" ? target.args[1] ?? ANY : ANY]) : genericOf("Option", [ANY])
    const expected = fn.node.async && single(declared.type, env)?.name === "Promise" ? single(declared.type, env).args[0] ?? ANY : declared.type
    if (accepts(expected, returned, env)) return
    report(node, `"?" returns the ${target.name === "Result" ? "Err" : "None"} from "${declared.name}", but "${declared.name}" returns ${describe(expected)}`)
}

function visibleNames(path_, env) {
    const names = new Set([...env.importedLocals, ...env.structs.keys(), ...env.enums.keys()])
    for (let scope = path_.scope; scope; scope = scope.parent) {
        for (const name of Object.keys(scope.bindings)) names.add(name)
    }
    return names
}

export function checkUndefinedName(path_, env, report) {
    if (env.openGlobals || !path_.isReferencedIdentifier()) return
    const { name } = path_.node
    if (name.startsWith("__") || path_.scope.getBinding(name) || env.importedLocals.has(name)) return
    if (env.structs.has(name) || env.enums.has(name) || env.aliases.has(name) || env.customTypes.has(name)) return
    if (knownGlobal(name, env) || t.isUnaryExpression(path_.parent, { operator: "typeof" })) return
    if (name === "arguments" && path_.findParent(parent => parent.isFunction() && !parent.isArrowFunctionExpression())) return

    if (VARIANT_SHORTHANDS.has(name)) {
        report(path_.node, `"${name}" is not defined — write ${VARIANT_SHORTHANDS.get(name)}.${name}`)
        return
    }
    const suggestion = didYouMean(name, visibleNames(path_, env))
    report(path_.node, `"${name}" is not defined${suggestion || ` — declare it, import it with "use", or list it in "globals" in the config if the host provides it`}`)
}

export function checkSwitchCases(node, path_, env, report) {
    const subject = infer(node.discriminant, path_, env)
    if (!subject) return
    for (const entry of node.cases) {
        if (!entry.test || t.isNullLiteral(entry.test)) continue
        const type = infer(entry.test, path_, env)
        if (type && !overlaps(subject, type, env)) report(entry.test, `this case never matches: ${describe(subject)} and ${describe(type)} have no value in common`)
    }
}

export function parameterExpects(parameter, type, argument, path_, env) {
    if (parameter.required !== false) return type
    const given = infer(argument, path_, env)
    return given && atoms(given, env).some(atom => isNamed(atom, "undefined")) ? unionOf([type, UNDEFINED]) : type
}

export function checkUseBeforeDeclaration(path_, report) {
    const { node } = path_
    if (typeof node.start !== "number" || !path_.isReferencedIdentifier()) return
    const binding = path_.scope.getBinding(node.name)
    if (!binding || (binding.kind !== "let" && binding.kind !== "const") || node === binding.identifier) return
    if (!binding.path.isVariableDeclarator() && !binding.path.isClassDeclaration()) return
    const declaration = binding.path.node
    if (typeof declaration.end !== "number" || typeof binding.identifier.start !== "number" || node.start >= declaration.end) return
    if (node.start > binding.identifier.start && node.start < (declaration.init?.start ?? -1)) return
    if (binding.path.isClassDeclaration() && node.start >= declaration.body.start) return
    if (path_.findParent(parent => parent.isCallExpression() && t.isIdentifier(parent.node.callee, { name: "__type_def__" }))) return
    if (binding.path.isVariableDeclarator() && binding.path.parentPath.parentPath?.isFor()) return
    const declared = binding.path.getFunctionParent()?.node ?? null
    if ((path_.getFunctionParent()?.node ?? null) !== declared) return
    report(node, `"${node.name}" is used before its declaration — move the declaration above`)
}
