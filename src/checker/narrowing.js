import * as t from "@babel/types"
import { infer, signatureFor } from "./infer.js"
import { ANY, named, literal, enumMember, unionOf } from "../external/typeSyntax.js"
import {
    BUILTIN_CLASSES, INT, NUMERIC, accepts, acceptsAtom, atoms, enumVariants, isArrayLike, isNamed, isNever, isNullish, isOpen,
    literalBase, single, structFor
} from "./core.js"

const NEVER = named("never")

const bindingIds = new WeakMap()
let nextBindingId = 0

const isKindCall = (name, path_) => name === "__kindof__" || (name === "type" && !path_.scope.getBinding("type"))

function presentEntry(type, object, path_, env) {
    const owner = infer(object, path_, env)
    const record = owner && single(owner, env)
    if (record?.kind !== "generic" || record.name !== "Record") return type
    if (atoms(record.args[1] ?? ANY, env).some(atom => isNamed(atom, "undefined"))) return type
    return keep(type, env, atom => !isNamed(atom, "undefined"))
}

export function refKey(node, path_) {
    if (t.isIdentifier(node)) {
        const binding = path_.scope.getBinding(node.name)
        if (!binding) return node.name === "undefined" ? null : `@${node.name}`
        if (!bindingIds.has(binding)) bindingIds.set(binding, `#${nextBindingId++}`)
        return bindingIds.get(binding)
    }
    if (t.isThisExpression(node)) return "this"
    if (!t.isMemberExpression(node) && !t.isOptionalMemberExpression(node)) return null
    const property = node.property
    if (!node.computed) {
        if (!t.isIdentifier(property)) return null
        const base = refKey(node.object, path_)
        return base && `${base}.${property.name}`
    }
    let segment = null
    if (t.isStringLiteral(property)) {
        segment = t.isValidIdentifier(property.value, false) ? `.${property.value}` : `[${escapeKey(JSON.stringify(property.value))}]`
    } else if (t.isNumericLiteral(property)) segment = `[${property.value}]`
    else if (t.isTemplateLiteral(property)) {
        const inner = templateKey(property, path_)
        segment = inner && `[${inner}]`
    } else {
        const inner = refKey(property, path_)
        segment = inner && `[${inner}]`
    }
    if (!segment) return null
    const base = refKey(node.object, path_)
    return base && base + segment
}

const escapeKey = text => text.replace(/\[/g, "\\u005b").replace(/\]/g, "\\u005d")

function templateKey(node, path_) {
    let text = "`"
    for (const [index, quasi] of node.quasis.entries()) {
        text += escapeKey(quasi.value.raw)
        if (index < node.expressions.length) {
            const inner = refKey(node.expressions[index], path_)
            if (!inner) return null
            text += "${" + inner + "}"
        }
    }
    return text + "`"
}

function keep(type, env, predicate) {
    const kept = atoms(type, env).filter(predicate)
    return kept.length === 0 ? NEVER : unionOf(kept)
}

function typeofName(atom, env) {
    switch (atom.kind) {
        case "literal": return typeof atom.value === "boolean" ? "boolean" : typeof atom.value
        case "array":
        case "tuple":
        case "generic":
        case "shape":
            return "object"
        case "function":
            return "function"
        case "named":
            if (NUMERIC.has(atom.name)) return "number"
            if (atom.name === "bool") return "boolean"
            if (atom.name === "null") return "object"
            if (["string", "undefined", "function", "bigint", "symbol"].includes(atom.name)) return atom.name
            if (["object", "array", "element"].includes(atom.name) || BUILTIN_CLASSES.has(atom.name) || env.structs.has(atom.name) || env.classDefs.has(atom.name)) return "object"
    }
    return null
}

function kindName(atom, env) {
    if (atom.kind === "literal") return literalBase(atom).name
    if (atom.kind === "named") {
        if (["int", "float", "string", "bool", "null", "undefined", "element"].includes(atom.name)) return atom.name
        if (env.structs.has(atom.name)) return "struct"
        if (BUILTIN_CLASSES.has(atom.name)) return atom.name.toLowerCase()
    }
    if (atom.kind === "generic" && BUILTIN_CLASSES.has(atom.name)) return atom.name.toLowerCase()
    if (atom.kind === "enumMember") return "enum"
    if (atom.kind === "function") return "function"
    if (atom.kind === "shape") return "object"
    return null
}

const PRIMITIVE_TYPEOF = new Set(["string", "number", "boolean"])

function chainFacts(node, path_, env) {
    const facts = []
    for (let link = node; t.isMemberExpression(link) || t.isOptionalMemberExpression(link); link = link.object) {
        const key = refKey(link.object, path_)
        if (key) facts.push({ key, refine: type => keep(type, env, atom => !isNullish(atom)) })
    }
    return facts
}

const FALSY = new Set([0, "", false])

function alwaysTruthy(atom, env) {
    if (atom.kind === "literal") return !FALSY.has(atom.value)
    if (atom.kind === "array" || atom.kind === "tuple" || atom.kind === "function" || atom.kind === "shape") return true
    return (atom.kind === "named" || atom.kind === "generic") && !!env.structs.get(atom.name) && !env.structs.get(atom.name).trait
}

const isNullLiteral = node => t.isNullLiteral(node) || t.isIdentifier(node, { name: "undefined" })
export const isLiteralNode = node => t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)

function equalityFacts(test, positive, path_, env) {
    const { left, right } = test
    const loose = test.operator.length === 2

    const typeofSide = [[left, right], [right, left]].find(([a, b]) => t.isUnaryExpression(a, { operator: "typeof" }) && t.isStringLiteral(b))
    if (typeofSide) {
        const [{ argument }, { value }] = typeofSide
        const key = refKey(argument, path_)
        return key ? [{ key, refine: type => keep(type, env, atom => { const name = typeofName(atom, env); return name === null || (name === value) === positive }) }] : []
    }

    const kindSide = [[left, right], [right, left]].find(([a, b]) =>
        t.isCallExpression(a) && t.isIdentifier(a.callee) && isKindCall(a.callee.name, path_) && a.arguments.length === 1 && t.isStringLiteral(b))
    if (kindSide) {
        const [{ arguments: [argument] }, { value }] = kindSide
        const key = refKey(argument, path_)
        return key ? [{ key, refine: type => keep(type, env, atom => { const name = kindName(atom, env); return name === null || (name === value) === positive }) }] : []
    }

    const [ref, other] = refKey(left, path_) ? [left, right] : [right, left]
    const key = refKey(ref, path_)
    if (!key) return []

    if (isNullLiteral(other)) {
        const names = loose ? ["null", "undefined"] : [t.isNullLiteral(other) ? "null" : "undefined"]
        const matches = atom => atom.kind === "named" && names.includes(atom.name)
        const chain = !positive && names.includes("undefined") ? chainFacts(ref, path_, env) : []
        return [{ key, refine: type => keep(type, env, atom => matches(atom) === positive) }, ...chain]
    }

    if (isLiteralNode(other)) {
        const value = other.value
        const equal = (a, b) => loose ? a == b : a === b
        const coerces = atom => loose && PRIMITIVE_TYPEOF.has(typeofName(atom, env)) && typeofName(atom, env) !== typeof value
        const refine = positive
            ? type => keep(type, env, atom => atom.kind === "literal" ? equal(atom.value, value) : isOpen(atom, env) || coerces(atom) || acceptsAtom(atom, literal(value), env))
            : type => keep(type, env, atom => !(atom.kind === "literal" && equal(atom.value, value)))
        const chain = positive ? chainFacts(ref, path_, env) : []
        const alias = destructuredField(ref, path_)
        const aliased = alias ? discriminantFacts(alias.member, value, positive, alias.path, env) : []
        return [{ key, refine }, ...chain, ...discriminantFacts(ref, value, positive, path_, env), ...aliased]
    }

    if (t.isMemberExpression(other) && !other.computed && t.isIdentifier(other.object) && t.isIdentifier(other.property) &&
        env.enums.get(other.object.name)?.members.has(other.property.name)) {
        const member = enumMember(other.object.name, other.property.name)
        const definition = env.enums.get(member.name)
        const same = atom => atom.kind === "enumMember" && atom.name === member.name && atom.member === member.member
        const whole = atom => atom.kind === "named" && atom.name === member.name && !definition.variants
        const refine = type => {
            const kept = []
            for (const atom of atoms(type, env)) {
                if (whole(atom)) {
                    if (positive) kept.push(member)
                    else for (const name of definition.members) if (name !== member.member) kept.push(enumMember(member.name, name))
                } else if (positive ? same(atom) || atom.kind !== "enumMember" : !same(atom)) {
                    kept.push(atom)
                }
            }
            return kept.length === 0 ? NEVER : unionOf(kept)
        }
        return [{ key, refine }]
    }
    return []
}

function variantRefine(enumName, tag, positive, env) {
    return type => {
        const kept = []
        for (const atom of atoms(type, env)) {
            const variants = enumVariants(atom, env)
            if (!variants || atom.name !== enumName) {
                if (!positive || isOpen(atom, env)) kept.push(atom)
                continue
            }
            if (positive) {
                if (variants.tags.includes(tag)) kept.push({ kind: "enumMember", name: atom.name, member: tag, args: variants.args })
            } else if (atom.kind === "enumMember") {
                if (atom.member !== tag) kept.push(atom)
            } else {
                for (const other of variants.tags) if (other !== tag) kept.push({ kind: "enumMember", name: atom.name, member: other, args: variants.args })
            }
        }
        return kept.length ? unionOf(kept) : NEVER
    }
}

function variantFacts(test, truthy, path_, env) {
    const [subject, variant] = test.arguments
    const key = refKey(subject, path_)
    if (!key || !t.isMemberExpression(variant) || !t.isIdentifier(variant.object) || !t.isIdentifier(variant.property)) return []
    if (!env.enums.get(variant.object.name)?.variants?.has(variant.property.name)) return []
    return [{ key, refine: variantRefine(variant.object.name, variant.property.name, truthy, env) }]
}

function discriminantFacts(ref, value, positive, path_, env) {
    if (!(t.isMemberExpression(ref) || t.isOptionalMemberExpression(ref)) || ref.computed || !t.isIdentifier(ref.property)) return []
    const key = refKey(ref.object, path_)
    if (!key) return []

    const name = ref.property.name
    if (name === "$tag") {
        return [{ key, refine: type => {
            const enumName = atoms(type, env).map(atom => enumVariants(atom, env) && atom.name).find(Boolean)
            return enumName ? variantRefine(enumName, value, positive, env)(type) : type
        } }]
    }
    const fits = atom => {
        const field = structFor(atom, env)?.fields.get(name)
        if (!field) return true
        const only = single(field.type, env)
        if (positive) return accepts(field.type, literal(value), env)
        return !(only?.kind === "literal" && only.value === value)
    }
    return [{ key, refine: type => keep(type, env, atom => isNullish(atom) ? !positive : fits(atom)) }]
}

function destructuredField(node, path_) {
    if (!t.isIdentifier(node)) return null
    const binding = path_.scope.getBinding(node.name)
    if (!binding || binding.kind !== "const" || binding.constantViolations.length || !binding.path.isVariableDeclarator()) return null
    const { id } = binding.path.node
    let source = binding.path.node.init
    if (t.isCallExpression(source) && t.isIdentifier(source.callee, { name: "__typed_pattern__" })) source = source.arguments[0]
    if (!t.isObjectPattern(id) || !source) return null
    const property = id.properties.find(entry => t.isObjectProperty(entry) && !entry.computed && t.isIdentifier(entry.key) &&
        t.isIdentifier(entry.value, { name: node.name }))
    if (!property || !refKey(source, binding.path)) return null
    const root = rootBinding(source, binding.path)
    if (root?.constantViolations.length) return null
    return { member: t.memberExpression(source, t.identifier(property.key.name)), path: binding.path }
}

const aliasing = new Set()

function aliasFacts(test, truthy, path_, env) {
    if (!t.isIdentifier(test)) return []
    const binding = path_.scope.getBinding(test.name)
    if (!binding || binding.kind !== "const" || binding.constantViolations.length || !binding.path.isVariableDeclarator()) return []
    if (binding.path.node.id !== binding.identifier || aliasing.has(binding)) return []
    let init = binding.path.node.init
    if (t.isCallExpression(init) && t.isIdentifier(init.callee, { name: "__typed_variable__" })) init = init.arguments[0]
    if (!init || !(t.isBinaryExpression(init) || t.isLogicalExpression(init) || t.isUnaryExpression(init, { operator: "!" }) || t.isCallExpression(init))) return []
    if ((binding.path.getFunctionParent()?.node ?? null) !== (path_.getFunctionParent()?.node ?? null)) return []
    aliasing.add(binding)
    try {
        return factsFrom(init, truthy, binding.path, env)
    } finally {
        aliasing.delete(binding)
    }
}

function staticCheck(test, path_) {
    if (!t.isCallExpression(test) || test.arguments.length !== 1) return null
    const callee = test.callee
    if (!t.isMemberExpression(callee) || callee.computed || !t.isIdentifier(callee.object) || !t.isIdentifier(callee.property)) return null
    if (path_.scope.getBinding(callee.object.name)) return null
    return `${callee.object.name}.${callee.property.name}`
}

export function factsFrom(test, truthy, path_, env) {
    const cache = env.testFacts ??= new WeakMap()
    const entry = cache.get(test)
    const slot = truthy ? 1 : 0
    if (entry?.[slot]) return entry[slot]
    const at = typeof test.end === "number" ? test.end : Infinity
    const facts = testFacts(test, truthy, path_, env).map(fact => ({ ...fact, at: fact.at ?? at }))
    if (entry) entry[slot] = facts
    else cache.set(test, slot ? [null, facts] : [facts, null])
    return facts
}

function testFacts(test, truthy, path_, env) {
    if (t.isUnaryExpression(test, { operator: "!" })) return factsFrom(test.argument, !truthy, path_, env)

    if (t.isLogicalExpression(test)) {
        if (test.operator === "&&" && truthy) return [...factsFrom(test.left, true, path_, env), ...factsFrom(test.right, true, path_, env)]
        if (test.operator === "||" && !truthy) return [...factsFrom(test.left, false, path_, env), ...factsFrom(test.right, false, path_, env)]
        return []
    }

    const key = refKey(test, path_)
    if (key) {
        const aliased = aliasFacts(test, truthy, path_, env)
        if (!truthy) return [{ key, refine: type => keep(type, env, atom => !alwaysTruthy(atom, env)) }, ...aliased]
        return [
            { key, refine: type => keep(type, env, atom => !isNullish(atom) && !(atom.kind === "literal" && FALSY.has(atom.value))) },
            ...chainFacts(test, path_, env),
            ...aliased
        ]
    }

    if (t.isBinaryExpression(test) && ["==", "===", "!=", "!=="].includes(test.operator)) {
        return equalityFacts(test, test.operator.startsWith("=") === truthy, path_, env)
    }
    if (t.isCallExpression(test) && t.isIdentifier(test.callee, { name: "__variant_is__" }) && test.arguments.length === 2) {
        return variantFacts(test, truthy, path_, env)
    }
    if (t.isCallExpression(test) && t.isIdentifier(test.callee, { name: "__match_eq__" }) && test.arguments.length === 2) {
        const [left, right] = test.arguments
        return equalityFacts({ left, right, operator: "===" }, truthy, path_, env)
    }

    if (t.isBinaryExpression(test, { operator: "in" }) && !t.isStringLiteral(test.left) && truthy) {
        const member = t.memberExpression(test.right, test.left, true)
        const key = refKey(member, path_)
        return key ? [{ key, refine: type => presentEntry(type, test.right, path_, env) }] : []
    }

    if (t.isBinaryExpression(test, { operator: "in" }) && t.isStringLiteral(test.left)) {
        const key = refKey(test.right, path_)
        if (!key) return []
        const entry = truthy && refKey(t.memberExpression(test.right, t.stringLiteral(test.left.value), true), path_)
        const facts = entry ? [{ key: entry, refine: type => presentEntry(type, test.right, path_, env) }] : []
        const field = test.left.value
        const has = atom => {
            const struct = structFor(atom, env)
            if (!struct || struct.open) return null
            const entry = struct.fields.get(field)
            if (entry) return entry.optional ? null : true
            return struct.methods.has(field) ? true : false
        }
        return [...facts, { key, refine: type => keep(type, env, atom => {
            if (isNullish(atom)) return false
            const present = has(atom)
            return present === null || present === truthy
        }) }]
    }

    if (t.isBinaryExpression(test, { operator: "instanceof" }) && t.isIdentifier(test.right)) {
        const key = refKey(test.left, path_)
        const name = test.right.name
        const matches = atom => (atom.kind === "named" || atom.kind === "generic") && atom.name === name
        if (!key) return []
        return [{ key, refine: truthy
            ? type => atoms(type, env).some(matches) ? keep(type, env, matches) : named(name)
            : type => keep(type, env, atom => !matches(atom)) }]
    }

    const check = staticCheck(test, path_)
    if (check === "Array.isArray") {
        const key = refKey(test.arguments[0], path_)
        return key ? [{ key, refine: type => keep(type, env, atom => isArrayLike(atom) === truthy) }] : []
    }
    if (check === "Number.isInteger" && truthy) {
        const key = refKey(test.arguments[0], path_)
        const toInt = atom => isNamed(atom, "number") ? INT : atom
        return key ? [{ key, refine: type => unionOf(atoms(keep(type, env, atom => !isNamed(atom, "float")), env).map(toInt)) }] : []
    }
    return []
}

export function exits(statement, never = null) {
    if (!statement) return false
    if (t.isReturnStatement(statement) || t.isThrowStatement(statement) ||
        t.isContinueStatement(statement) || t.isBreakStatement(statement)) return true
    if (t.isBlockStatement(statement)) return statement.body.some(inner => exits(inner, never))
    if (t.isIfStatement(statement)) return exits(statement.consequent, never) && exits(statement.alternate, never)
    if (t.isTryStatement(statement)) return exits(statement.block, never) && (!statement.handler || exits(statement.handler.body, never))
    if (t.isExpressionStatement(statement) && never) return never(statement.expression)
    return false
}

function neverCall(path_, env) {
    return expression => {
        if (!t.isCallExpression(expression)) return false
        const callee = expression.callee
        if (t.isMemberExpression(callee) && !callee.computed && t.isIdentifier(callee.object, { name: "process" }) &&
            t.isIdentifier(callee.property, { name: "exit" }) && !path_.scope.getBinding("process")) return true
        if (!t.isIdentifier(callee)) return false
        const returns = signatureFor(callee.name, path_, env)?.returns
        return !!returns && isNever(returns)
    }
}

function breaksOut(node, nested = false) {
    if (!node || typeof node !== "object") return false
    if (Array.isArray(node)) return node.some(child => breaksOut(child, nested))
    if (t.isFunction(node)) return false
    if (t.isBreakStatement(node)) return !!node.label || !nested
    const inner = nested || t.isLoop(node) || t.isSwitchStatement(node)
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
        if (breaksOut(node[key], inner)) return true
    }
    return false
}

function switchFacts(casePath, env) {
    const switchPath = casePath.parentPath
    const { discriminant, cases } = switchPath.node
    const index = casePath.key
    const exitsCase = entry => entry.consequent.some(statement => exits(statement))
    const test = entry => t.isBooleanLiteral(discriminant, { value: true }) ? entry.test
        : { type: "BinaryExpression", operator: "===", left: discriminant, right: entry.test, end: entry.test.end }

    const flowing = new Set()
    for (let current = index; current >= 0; current--) {
        if (current < index && exitsCase(cases[current])) break
        flowing.add(current)
    }
    const first = Math.min(...flowing)
    const at = cases[first].test?.end ?? cases[first].start
    if (typeof at !== "number") return []

    if (!cases[index].test) {
        const facts = []
        cases.forEach((entry, position) => {
            if (flowing.has(position) || !entry.test) return
            facts.push(...factsFrom(test(entry), false, switchPath, env).map(fact => ({ ...fact, at })))
        })
        return facts
    }
    if ([...flowing].some(position => !cases[position].test)) return []
    const groups = [...flowing].map(position => factsFrom(test(cases[position]), true, switchPath, env))
    return anyOf(groups).map(fact => ({ ...fact, at }))
}

function anyOf(groups) {
    if (groups.length === 1) return groups[0]
    const keys = groups.map(group => new Set(group.map(fact => fact.key)))
    const common = [...keys[0]].filter(key => keys.every(set => set.has(key)))
    return common.map(key => ({
        key,
        at: Math.max(...groups.flatMap(group => group.filter(fact => fact.key === key).map(fact => fact.at))),
        refine: type => unionOf(groups.map(group => group.filter(fact => fact.key === key).reduce((current, fact) => fact.refine(current), type)))
    }))
}

function ownFacts(parent, child, env) {
    const node = parent.node
    const facts = []
    if ((parent.isIfStatement() || parent.isConditionalExpression()) && child.key !== "test") {
        facts.push(...factsFrom(node.test, child.key === "consequent", parent, env))
    } else if (parent.isLogicalExpression() && child.key === "right" && node.operator !== "??") {
        facts.push(...factsFrom(node.left, node.operator === "&&", parent, env))
    } else if ((parent.isWhileStatement() || parent.isForStatement()) && child.key === "body" && node.test) {
        facts.push(...factsFrom(node.test, true, parent, env))
    } else if (parent.isSwitchCase() && child.listKey === "consequent" && parent.parentPath?.isSwitchStatement()) {
        facts.push(...switchFacts(parent, env))
    }

    if ((child.listKey === "body" || (child.listKey === "consequent" && parent.isSwitchCase())) && typeof child.key === "number") {
        facts.push(...precedingFacts(child.container, child.key, parent, env))
    }
    return facts
}

function ancestorFacts(path_, env) {
    const cache = env.ancestorFacts ??= new WeakMap()
    const chain = []
    let current = path_
    while (current && !cache.has(current)) {
        chain.push(current)
        current = current.parentPath
    }
    let above = current ? cache.get(current) : []
    for (let index = chain.length - 1; index >= 0; index--) {
        const child = chain[index]
        const parent = child.parentPath
        let facts = []
        if (parent) {
            const own = ownFacts(parent, child, env)
            const inherited = parent.isFunction() ? above.map(fact => ({ ...fact, closure: parent.node })) : above
            facts = own.length || (parent.isLoop() && child.key === "body") ? [...own, ...inherited] : inherited
        }
        cache.set(child, facts)
        above = facts
    }
    return above
}

export function factContext(path_, env) {
    return ancestorFacts(path_, env)
}

function statementFacts(statement, path_, env) {
    const facts = assignmentFacts(statement, path_, env)
    if ((t.isWhileStatement(statement) || t.isForStatement(statement) || t.isDoWhileStatement(statement)) && statement.test &&
        typeof statement.end === "number" && !breaksOut(statement.body)) {
        facts.push(...factsFrom(statement.test, false, path_, env).map(fact => ({ ...fact, at: statement.end })))
        return facts
    }
    if (!t.isIfStatement(statement)) return facts
    const never = neverCall(path_, env)
    const then = exits(statement.consequent, never)
    const otherwise = exits(statement.alternate, never)
    if (then && !otherwise) {
        facts.push(...factsFrom(statement.test, false, path_, env))
        if (statement.alternate) facts.push(...branchFacts(statement.alternate, path_, env))
    } else if (otherwise && !then) {
        facts.push(...factsFrom(statement.test, true, path_, env))
        facts.push(...branchFacts(statement.consequent, path_, env))
    }
    return facts
}

function branchFacts(branch, path_, env) {
    const body = t.isBlockStatement(branch) ? branch.body : [branch]
    if (body.some(statement => t.isDeclaration(statement))) return []
    return body.flatMap(statement => statementFacts(statement, path_, env))
}

function precedingFacts(siblings, index, path_, env) {
    if (index === 0) return []
    const statement = siblings[index]
    if (env.siblingFacts.has(statement)) return env.siblingFacts.get(statement)
    const facts = [...precedingFacts(siblings, index - 1, path_, env), ...statementFacts(siblings[index - 1], path_, env)]
    env.siblingFacts.set(statement, facts)
    return facts
}

function assignment(statement) {
    const expression = t.isExpressionStatement(statement) ? statement.expression : null
    return t.isAssignmentExpression(expression, { operator: "=" }) ? expression : null
}

const LOGICAL_ASSIGNMENT = new Set(["??=", "||=", "&&="])

export function logicalAssigned(operator, type, assigned, env) {
    if (!type || !assigned) return null
    const all = atoms(type, env)
    const kept = operator === "??=" ? all.filter(atom => !isNullish(atom))
        : operator === "||=" ? all.filter(atom => !isNullish(atom) && !(atom.kind === "literal" && FALSY.has(atom.value)))
        : all.filter(atom => !alwaysTruthy(atom, env))
    if (kept.length && accepts(unionOf(kept), assigned, env)) return unionOf(kept)
    return unionOf([...kept, assigned])
}

function assignedType(right, type, path_, env) {
    const assigned = infer(right, path_, env)
    if (!assigned) return type
    if (t.isObjectExpression(right) || t.isArrayExpression(right)) {
        const kept = atoms(type, env).filter(atom => !isNullish(atom) && atom.kind !== "any" && !isOpen(atom, env) && accepts(atom, assigned, env))
        if (kept.length) return unionOf(kept)
    }
    return assigned
}

function assignmentFacts(statement, path_, env) {
    const direct = assignment(statement)
    if (direct) {
        const key = refKey(direct.left, path_)
        return key ? [{ key, at: statement.end, refine: type => assignedType(direct.right, type, path_, env) }] : []
    }
    const expression = t.isExpressionStatement(statement) ? statement.expression : null
    if (t.isAssignmentExpression(expression) && LOGICAL_ASSIGNMENT.has(expression.operator)) {
        const key = refKey(expression.left, path_)
        return key ? [{
            key,
            at: statement.end,
            refine: type => logicalAssigned(expression.operator, type, infer(expression.right, path_, env), env) ?? type
        }] : []
    }
    if (!t.isIfStatement(statement) || statement.alternate || exits(statement.consequent)) return []
    const body = t.isBlockStatement(statement.consequent) ? statement.consequent.body : [statement.consequent]
    const last = assignment(body.at(-1))
    const key = last && refKey(last.left, path_)
    if (!key) return []
    return [{
        key,
        at: statement.end,
        refine: type => {
            const assigned = assignedType(last.right, type, path_, env)
            if (!infer(last.right, path_, env)) return type
            const otherwise = factsFrom(statement.test, false, path_, env).filter(fact => fact.key === key)
            return unionOf([otherwise.reduce((current, fact) => fact.refine(current), type), assigned])
        }
    }]
}

function rootBinding(node, path_) {
    while (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) node = node.object
    return t.isIdentifier(node) ? path_.scope.getBinding(node.name) : null
}

export function withFacts(env, facts, run) {
    env.facts.push(...facts)
    try {
        return run()
    } finally {
        env.facts.length -= facts.length
    }
}

function enclosingLoops(path_) {
    const loops = []
    for (let current = path_; current && !current.isFunction(); current = current.parentPath) {
        if (current.isLoop() && typeof current.node.start === "number") loops.push({ start: current.node.start, end: current.node.end })
    }
    return loops
}

function keyParts(node, path_, bindings, members) {
    if (t.isIdentifier(node)) {
        const binding = path_.scope.getBinding(node.name)
        if (binding) bindings.push(binding)
        return
    }
    if (t.isTemplateLiteral(node)) {
        node.expressions.forEach(expression => keyParts(expression, path_, bindings, members))
        return
    }
    if (!t.isMemberExpression(node) && !t.isOptionalMemberExpression(node)) return
    members.push(node)
    if (node.computed) keyParts(node.property, path_, bindings, members)
    keyParts(node.object, path_, bindings, members)
}

function keySegments(key) {
    const root = /^[^.[]*/.exec(key)[0]
    const segments = []
    let index = root.length
    while (index < key.length) {
        if (key[index] === ".") {
            const name = /^[^.[]*/.exec(key.slice(index + 1))[0]
            segments.push({ field: name })
            index += name.length + 1
            continue
        }
        let depth = 0
        let end = index
        for (; end < key.length; end++) {
            if (key[end] === "[") depth++
            else if (key[end] === "]" && --depth === 0) break
        }
        const inner = key.slice(index + 1, end)
        segments.push({ index: inner, dynamic: !/^(\d|")/.test(inner) })
        index = end + 1
    }
    return { root, segments }
}

function mayAlias(written, target) {
    if (written.field !== undefined && target.field !== undefined) return written.field === target.field
    if (written.field !== undefined) return target.dynamic
    if (target.field !== undefined) return written.dynamic
    return written.dynamic || target.dynamic || written.index === target.index
}

function writtenOver(written, target) {
    return written.length <= target.length && written.every((segment, index) => mayAlias(segment, target[index]))
}

function memberWriteIndex(env) {
    if (env.memberWriteIndex?.size === env.memberWrites.size) return env.memberWriteIndex.byRoot
    const byRoot = new Map()
    for (const [written, positions] of env.memberWrites) {
        const { root, segments } = keySegments(written)
        if (!byRoot.has(root)) byRoot.set(root, [])
        byRoot.get(root).push({ segments, positions })
    }
    env.memberWriteIndex = { size: env.memberWrites.size, byRoot }
    return byRoot
}

function memberWritesOver(key, env) {
    const { root, segments } = keySegments(key)
    return (memberWriteIndex(env).get(root) ?? []).filter(entry => writtenOver(entry.segments, segments)).flatMap(entry => entry.positions)
}

export function narrowed(node, path_, env, type) {
    if (!type) return type

    const key = refKey(node, path_)
    if (!key) return type
    const facts = [...env.facts, ...ancestorFacts(path_, env)].filter(fact => fact.key === key)
    if (facts.length === 0) return type

    const bindings = []
    const members = []
    keyParts(node, path_, bindings, members)
    const writes = bindings.flatMap(entry => entry.constantViolations.map(violation => violation.node.start))
    if (key.startsWith("@")) writes.push(...(env.memberWrites.get(/^[^.[]*/.exec(key)[0]) ?? []))
    for (const member of members) {
        const memberKey = member === node ? key : refKey(member, path_)
        if (memberKey) writes.push(...memberWritesOver(memberKey, env))
    }
    const positionless = writes.some(start => typeof start !== "number") || (writes.length > 0 && typeof node.start !== "number")
    const sorted = positionless ? [] : writes.sort((a, b) => a - b)
    const writtenBetween = (from, to) => {
        let low = 0
        let high = sorted.length
        while (low < high) {
            const middle = (low + high) >> 1
            if (sorted[middle] > from) high = middle
            else low = middle + 1
        }
        return low < sorted.length && sorted[low] < to
    }
    let writtenElsewhere = null
    const laterWrites = closure => {
        if (writtenBetween(closure.start, Infinity)) return true
        if (writtenElsewhere === null) {
            writtenElsewhere = bindings.some(entry => {
                const own = entry.scope.getFunctionParent()?.path.node ?? null
                return entry.constantViolations.some(violation => (violation.getFunctionParent()?.node ?? null) !== own)
            })
        }
        return writtenElsewhere
    }
    const loops = sorted.length ? enclosingLoops(path_).filter(loop => writtenBetween(loop.start, loop.end)) : []
    const stillHolds = fact => !positionless && !(fact.closure && laterWrites(fact.closure)) &&
        !writtenBetween(fact.at, node.start) && !loops.some(loop => fact.at < loop.start)

    return facts.filter(stillHolds).sort((a, b) => a.at - b.at).reduce((current, fact) => fact.refine(current), type)
}
