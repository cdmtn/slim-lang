import * as t from "@babel/types"
import { enumMember, formatType, literal, named, readType, substituteType, unionOf } from "../../external/typeSyntax.js"
import { UNDEFINED, accepts, atoms, describe, enumVariants, isNamed, isNullish, single, structFor, widen } from "../core.js"
import { isLiteralNode } from "../narrowing.js"
import { infer } from "../infer.js"

export function matchExpression(node) {
    if (!t.isCallExpression(node) || node.arguments.length !== 1) return null

    const callee = node.callee
    if (!t.isArrowFunctionExpression(callee) || callee.params.length !== 1) return null
    if (!t.isIdentifier(callee.params[0], { name: "__match" })) return null
    if (!t.isBlockStatement(callee.body)) return null

    const covered = []
    const types = []
    const shapes = []
    const arms = []
    let wildcard = false
    let guarded = false
    let opaque = false
    let fallback = null

    for (const statement of callee.body.body) {
        if (t.isBlockStatement(statement)) { guarded = true; continue }

        if (t.isIfStatement(statement)) {
            const test = statement.test
            arms.push({ test, complete: !t.isIfStatement((statement.consequent.body ?? []).at(-1)) })
            if (t.isCallExpression(test) && t.isIdentifier(test.callee, { name: "__match_eq__" })) {
                covered.push(test.arguments[1])
            } else if (t.isCallExpression(test) && t.isIdentifier(test.callee, { name: "__variant_is__" })) {
                const body = statement.consequent.body ?? []
                if (!t.isIfStatement(body.at(-1))) covered.push(test.arguments[1])
            } else if (t.isCallExpression(test) && t.isIdentifier(test.callee, { name: "__match_type__" }) && t.isStringLiteral(test.arguments[1])) {
                const body = statement.consequent.body ?? []
                if (!t.isIfStatement(body.at(-1))) types.push(readType(test.arguments[1].value))
            } else {
                const shape = shapeTest(test)
                if (!shape) opaque = true
                else if (!t.isIfStatement((statement.consequent.body ?? []).at(-1))) shapes.push(shape)
            }
            continue
        }

        if (t.isReturnStatement(statement)) {
            wildcard = !t.isIdentifier(statement.argument, { name: "undefined" })
            if (!wildcard) fallback = statement
        }
    }

    return { covered, types, shapes, arms, wildcard, guarded, opaque, fallback, scrutinee: node.arguments[0] }
}

const isMatchSubject = node => t.isIdentifier(node, { name: "__match" })

function conjunction(test) {
    return t.isLogicalExpression(test, { operator: "&&" }) ? [...conjunction(test.left), ...conjunction(test.right)] : [test]
}

function shapeTest(test) {
    const fields = []
    let object = false
    for (const part of conjunction(test)) {
        if (t.isBinaryExpression(part, { operator: "===" }) && t.isUnaryExpression(part.left, { operator: "typeof" }) &&
            isMatchSubject(part.left.argument) && t.isStringLiteral(part.right, { value: "object" })) {
            object = true
            continue
        }
        if (t.isBinaryExpression(part, { operator: "!==" }) && isMatchSubject(part.left) && t.isNullLiteral(part.right)) continue
        if (t.isCallExpression(part) && t.isIdentifier(part.callee, { name: "__match_eq__" })) {
            const [member, value] = part.arguments
            const field = t.isMemberExpression(member) && isMatchSubject(member.object)
                ? (!member.computed && t.isIdentifier(member.property) ? member.property.name : t.isStringLiteral(member.property) ? member.property.value : null)
                : null
            if (field !== null && isLiteralNode(value)) {
                fields.push({ field, value: value.value })
                continue
            }
        }
        return null
    }
    return object ? fields : null
}

function coversShape(atom, fields, env) {
    const struct = structFor(atom, env)
    return fields.every(({ field, value }) => {
        const only = struct.fields.get(field) && single(struct.fields.get(field).type, env)
        return only?.kind === "literal" && only.value === value
    })
}

function armEnumName(object, env) {
    if (!t.isIdentifier(object)) return null
    if (env.enums.has(object.name)) return object.name
    const bare = /^__(\w+)__$/.exec(object.name)?.[1]
    return bare && env.enums.get(bare)?.builtin ? bare : null
}

function armKey(arm, env) {
    if (t.isNullLiteral(arm)) return "null"
    if (t.isIdentifier(arm, { name: "undefined" })) return "undefined"
    if (isLiteralNode(arm)) return `literal:${typeof arm.value}:${arm.value}`
    if (t.isMemberExpression(arm) && !arm.computed && t.isIdentifier(arm.property)) {
        const name = armEnumName(arm.object, env)
        if (name) return `member:${name}.${arm.property.name}`
    }
    return null
}

function atomKey(atom) {
    if (isNamed(atom, "null") || isNamed(atom, "undefined")) return atom.name
    if (atom.kind === "literal") return `literal:${typeof atom.value}:${atom.value}`
    if (atom.kind === "enumMember") return `member:${atom.name}.${atom.member}`
    return null
}

function expandCases(all, env) {
    const expanded = []
    for (const atom of all) {
        if (isNamed(atom, "bool")) {
            expanded.push({ atom: literal(true), origin: atom }, { atom: literal(false), origin: atom })
            continue
        }
        const definition = (atom.kind === "named" || atom.kind === "generic") ? env.enums.get(atom.name) : null
        if (definition?.members?.size) {
            for (const member of definition.members) expanded.push({ atom: { ...enumMember(atom.name, member), args: atom.args ?? [] }, origin: atom })
            continue
        }
        expanded.push({ atom, origin: atom })
    }
    return expanded
}

function collapseMissing(missing, expanded, collapseEnums) {
    const labels = []
    const done = new Set()
    for (const entry of missing) {
        const { origin } = entry
        if (done.has(origin)) continue
        const group = expanded.filter(other => other.origin === origin)
        const whole = group.length > 1 && group.every(other => missing.includes(other)) && (isNamed(origin, "bool") || collapseEnums)
        if (whole) {
            done.add(origin)
            labels.push(formatType(origin))
        } else {
            labels.push(caseLabel(entry.atom))
        }
    }
    return labels
}

const caseLabel = atom => atom.kind === "enumMember" ? `${atom.name}.${atom.member}` : formatType(atom)

function variantReference(node, env) {
    if (!t.isMemberExpression(node) || node.computed || !t.isIdentifier(node.property)) return null
    const name = armEnumName(node.object, env)
    const definition = name && env.enums.get(name)
    return definition?.variants?.has(node.property.name) ? { name, tag: node.property.name } : null
}

function patternPath(node, env) {
    if (isMatchSubject(node)) return []
    if (t.isCallExpression(node) && t.isIdentifier(node.callee, { name: "__variant_value__" }) && t.isNumericLiteral(node.arguments[2])) {
        const base = patternPath(node.arguments[0], env)
        const variant = variantReference(node.arguments[1], env)
        return base && variant ? [...base, { variant, index: node.arguments[2].value }] : null
    }
    if (t.isMemberExpression(node) && node.computed && t.isNumericLiteral(node.property)) {
        const base = patternPath(node.object, env)
        return base && [...base, { index: node.property.value }]
    }
    if (t.isMemberExpression(node) && (node.computed ? t.isStringLiteral(node.property) : t.isIdentifier(node.property))) {
        const base = patternPath(node.object, env)
        return base && [...base, { prop: node.computed ? node.property.value : node.property.name }]
    }
    return null
}

function armPattern(test, env) {
    const root = {}
    let nested = false
    const at = steps => {
        let current = root
        for (const step of steps) {
            if (step.variant) {
                if (current.variant && (current.variant.name !== step.variant.name || current.variant.tag !== step.variant.tag)) current.impossible = true
                current.variant ??= step.variant
                current.fields ??= new Map()
                if (!current.fields.has(step.index)) current.fields.set(step.index, {})
                current = current.fields.get(step.index)
            } else if (step.prop !== undefined) {
                current.object = true
                current.props ??= new Map()
                if (!current.props.has(step.prop)) current.props.set(step.prop, {})
                current = current.props.get(step.prop)
            } else {
                current.items ??= new Map()
                if (!current.items.has(step.index)) current.items.set(step.index, {})
                current = current.items.get(step.index)
            }
        }
        return current
    }
    for (const part of conjunction(test)) {
        if (t.isCallExpression(part) && t.isIdentifier(part.callee, { name: "__variant_is__" }) && part.arguments.length === 2) {
            const steps = patternPath(part.arguments[0], env)
            const variant = variantReference(part.arguments[1], env)
            if (!steps || !variant) return null
            if (steps.length) nested = true
            const target = at(steps)
            if (target.variant && (target.variant.name !== variant.name || target.variant.tag !== variant.tag)) target.impossible = true
            target.variant ??= variant
            target.fields ??= new Map()
            continue
        }
        if (t.isCallExpression(part) && t.isIdentifier(part.callee, { name: "__match_eq__" }) && part.arguments.length === 2) {
            const steps = patternPath(part.arguments[0], env)
            const key = armKey(part.arguments[1], env)
            if (!steps || key === null) return null
            if (steps.length) nested = true
            at(steps).key = key
            continue
        }
        if (t.isCallExpression(part) && t.isIdentifier(part.callee, { name: "__match_type__" }) && t.isStringLiteral(part.arguments[1])) {
            const steps = patternPath(part.arguments[0], env)
            if (!steps) return null
            if (steps.length) nested = true
            at(steps).type = readType(part.arguments[1].value)
            continue
        }
        if (t.isCallExpression(part) && t.isMemberExpression(part.callee) && t.isIdentifier(part.callee.object, { name: "Array" }) &&
            t.isIdentifier(part.callee.property, { name: "isArray" }) && part.arguments.length === 1) {
            const steps = patternPath(part.arguments[0], env)
            if (!steps) return null
            nested = true
            at(steps).items ??= new Map()
            continue
        }
        if ((t.isBinaryExpression(part, { operator: "===" }) || t.isBinaryExpression(part, { operator: ">=" })) && t.isMemberExpression(part.left) &&
            !part.left.computed && t.isIdentifier(part.left.property, { name: "length" }) && t.isNumericLiteral(part.right)) {
            const steps = patternPath(part.left.object, env)
            if (!steps) return null
            nested = true
            const target = at(steps)
            target.items ??= new Map()
            if (part.operator === "===") target.length = part.right.value
            else target.min = part.right.value
            continue
        }
        if (t.isBinaryExpression(part, { operator: "===" }) && t.isUnaryExpression(part.left, { operator: "typeof" }) && t.isStringLiteral(part.right, { value: "object" })) {
            const steps = patternPath(part.left.argument, env)
            if (!steps) return null
            nested = true
            at(steps).object = true
            continue
        }
        if (t.isBinaryExpression(part, { operator: "!==" }) && t.isNullLiteral(part.right) && patternPath(part.left, env)) continue
        return null
    }
    return { root, nested }
}

function columnCases(type, env, nodes = []) {
    const cases = []
    const lengths = nodes.filter(node => node.items).map(node => node.length ?? node.min ?? 0)
    const names = [...new Set(nodes.flatMap(node => [...(node.props?.keys() ?? [])]))]
    for (const atom of atoms(type, env)) {
        if (isNamed(atom, "bool")) {
            cases.push({ key: "literal:boolean:true", label: "true", fields: [] }, { key: "literal:boolean:false", label: "false", fields: [] })
            continue
        }
        const variants = enumVariants(atom, env)
        if (variants) {
            for (const tag of variants.tags) {
                const fields = variants.definition.variants.get(tag)
                cases.push({
                    variant: { name: atom.name, tag },
                    key: `member:${atom.name}.${tag}`,
                    label: `${atom.name}.${tag}`,
                    fields: (fields ?? []).map(field => variants.bound.size ? substituteType(field.type, variants.bound) : field.type),
                    atom
                })
            }
            continue
        }
        const definition = (atom.kind === "named" || atom.kind === "generic") ? env.enums.get(atom.name) : null
        if (definition?.members?.size && !definition.variants) {
            for (const member of definition.members) cases.push({ key: `member:${atom.name}.${member}`, label: `${atom.name}.${member}`, fields: [] })
            continue
        }
        const key = atomKey(atom)
        if (key !== null) {
            cases.push({ key, label: caseLabel(atom), fields: [] })
            continue
        }
        if (atom.kind === "tuple") {
            cases.push({ tuple: atom.items.length, label: "[]", fields: atom.items, atom })
            continue
        }
        if (atom.kind === "array" && lengths.length) {
            const longest = Math.max(...lengths)
            for (let length = 0; length <= longest + 1; length++) {
                cases.push({ tuple: length, atLeast: length > longest, label: "[]", fields: Array(length).fill(atom.element), atom })
            }
            continue
        }
        const struct = names.length ? structFor(atom, env) : null
        if (struct) {
            const fieldType = name => {
                const field = struct.fields.get(name)
                return !field ? UNDEFINED : field.optional ? unionOf([field.type, UNDEFINED]) : field.type
            }
            cases.push({ record: true, names, label: caseLabel(atom), fields: names.map(fieldType), atom })
            continue
        }
        cases.push({ opaque: true, label: caseLabel(atom), fields: [], atom })
    }
    return cases
}

const isWildPattern = node => !node.variant && node.key === undefined && !node.items && !node.type && !node.impossible && !node.object

function specialize(node, entry, env) {
    if (node.impossible) return null
    const wild = () => entry.fields.map(() => ({}))
    if (isWildPattern(node)) return wild()
    if (node.type) return accepts(node.type, entry.atom ?? (entry.variant ? named(entry.variant.name) : null), env) ? wild() : null
    if (node.variant) {
        if (!entry.variant || entry.variant.name !== node.variant.name || entry.variant.tag !== node.variant.tag) return null
        return entry.fields.map((_, index) => node.fields?.get(index) ?? {})
    }
    if (node.key !== undefined) return entry.key === node.key && entry.fields.length === 0 ? [] : null
    if (node.items) {
        if (entry.tuple === undefined) return null
        if (node.length !== undefined && (entry.atLeast || node.length !== entry.tuple)) return null
        if (node.min !== undefined && entry.tuple < node.min) return null
        return entry.fields.map((_, index) => node.items.get(index) ?? {})
    }
    if (node.object) {
        if (entry.record) return entry.names.map(name => node.props?.get(name) ?? {})
        if (node.props || entry.key !== undefined) return null
        return wild()
    }
    return null
}

function witnessLabel(entry, parts) {
    if (entry.record) {
        const shown = entry.names.map((name, index) => [name, parts[index]]).filter(([, part]) => part !== "_")
        return shown.length ? `${entry.label} { ${shown.map(([name, part]) => `${name}: ${part}`).join(", ")} }` : entry.label
    }
    if (entry.atLeast) return `[${[...parts, "..."].join(", ")}]`
    if (entry.tuple !== undefined) return `[${parts.join(", ")}]`
    return entry.fields.length ? `${entry.label}(${parts.join(", ")})` : entry.label
}

function uncovered(types, rows, env, depth = 0) {
    if (types.length === 0) return rows.length ? [] : [[]]
    if (rows.length === 0) return [types.map(() => "_")]
    if (depth > 40) return null
    const [head, ...rest] = types
    if (rows.length && rows.every(row => isWildPattern(row[0]))) {
        const found = uncovered(rest, rows.map(row => row.slice(1)), env, depth + 1)
        return found && found.map(witness => ["_", ...witness])
    }
    const witnesses = []
    for (const entry of columnCases(head, env, rows.map(row => row[0]))) {
        const specialized = []
        for (const row of rows) {
            const parts = specialize(row[0], entry, env)
            if (parts) specialized.push([...parts, ...row.slice(1)])
        }
        if (entry.opaque && specialized.length === 0) {
            if (!rows.some(row => row[0].type)) return null
        }
        const found = uncovered([...entry.fields, ...rest], specialized, env, depth + 1)
        if (found === null) return null
        for (const witness of found) {
            witnesses.push([witnessLabel(entry, witness.slice(0, entry.fields.length)), ...witness.slice(entry.fields.length)])
        }
    }
    return witnesses
}

function nestedMissing(match, type, env) {
    const rows = []
    let nested = false
    for (const arm of match.arms) {
        const parsed = armPattern(arm.test, env)
        if (!parsed) {
            if (arm.complete && !shapeTest(arm.test)) return null
            continue
        }
        if (parsed.nested) nested = true
        if (arm.complete) rows.push([parsed.root])
    }
    if (!nested) return undefined
    const found = uncovered([type], rows, env)
    return found && [...new Set(found.map(witness => witness[0]))]
}

export function missingCases(match, path_, env) {
    if (match.guarded) return null

    const inferred = infer(match.scrutinee, path_, env)
    const constant = armKey(match.scrutinee, env) !== null
    const type = inferred && constant
        ? unionOf(atoms(inferred, env).map(atom => atom.kind === "enumMember" ? named(atom.name) : widen(atom)))
        : inferred
    const all = type ? atoms(type, env) : []
    if (all.length === 0) return null

    const enumNamesOf = () => new Set(all.filter(atom => !isNullish(atom)).map(atom => atom.kind === "enumMember" || env.enums.has(atom.name) ? atom.name : null))
    if (match.arms) {
        const nested = nestedMissing(match, type, env)
        if (nested === null) return null
        if (nested) {
            const names = enumNamesOf()
            const [only] = names
            return { subject: names.size === 1 && only ? `"${only}"` : describe(type), missing: nested }
        }
    }
    if (match.opaque) return null

    const armKeys = new Set()
    for (const arm of match.covered) {
        const key = armKey(arm, env)
        if (key === null) return null
        armKeys.add(key)
    }

    const missing = []
    const expanded = expandCases(all, env)
    for (const entry of expanded) {
        const { atom } = entry
        const key = atomKey(atom)
        if (key !== null && armKeys.has(key)) continue
        if (match.types.some(covered => accepts(covered, atom, env))) continue
        if (match.shapes.some(fields => structFor(atom, env) && coversShape(atom, fields, env))) continue
        if (key !== null) {
            missing.push(entry)
            continue
        }
        if (match.types.length > 0 || (match.shapes.length > 0 && structFor(atom, env))) {
            missing.push(entry)
            continue
        }
        return null
    }

    const enumNames = new Set(all.filter(atom => !isNullish(atom)).map(atom => atom.kind === "enumMember" || env.enums.has(atom.name) ? atom.name : null))
    const [onlyEnum] = enumNames
    const subject = enumNames.size === 1 && onlyEnum ? `"${onlyEnum}"` : describe(type)
    return { subject, missing: collapseMissing(missing, expanded, match.types.length > 0) }
}
