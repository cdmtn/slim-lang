import * as t from "@babel/types"
import {
    ANY, named, literal, arrayOf, tupleOf, unionOf, formatType, substituteType, readType, genericOf
} from "../external/typeSyntax.js"

export const INT = named("int")
export const FLOAT = named("float")
export const NUMBER = named("number")
export const STRING = named("string")
export const BOOL = named("bool")
export const NULL = named("null")
export const UNDEFINED = named("undefined")
export const OBJECT = named("object")
export const ARRAY = named("array")
export const FUNCTION = named("function")
export const NUMERIC = new Set(["int", "float", "number"])

export const KNOWN = new Set([
    "int", "float", "number", "string", "bool", "null", "undefined",
    "object", "array", "function", "any", "element", "bigint", "symbol", "never", "Html", "SafeHtml", "enum"
])

export const HTML = named("Html")
export const isMarkupType = type => type?.kind === "named" && (type.name === "Html" || type.name === "SafeHtml")

export const BUILTIN_CLASSES = new Set(["Map", "Set", "Date", "Promise", "RegExp", "Error"])
export const isNamed = (type, name) => type?.kind === "named" && type.name === name
export const isNumeric = type => type?.kind === "named" && NUMERIC.has(type.name)
export const isNullish = type => isNamed(type, "null") || isNamed(type, "undefined")
export const isNever = type => isNamed(type, "never")

export function literalBase(type) {
    if (typeof type.value === "string") return STRING
    if (typeof type.value === "boolean") return BOOL
    return Number.isInteger(type.value) ? INT : FLOAT
}

export function widen(type) {
    if (!type) return type
    switch (type.kind) {
        case "literal": return literalBase(type)
        case "union": return unionOf(type.types.map(widen))
        case "array": return type.readonly ? { ...arrayOf(widen(type.element)), readonly: true } : arrayOf(widen(type.element))
        case "tuple": return type.readonly ? { ...tupleOf(type.items.map(widen)), readonly: true } : tupleOf(type.items.map(widen))
    }
    return type
}

export function describe(type) {
    const text = formatType(type)
    return (type.kind === "union" || type.kind === "intersection") && !text.endsWith("?") ? `(${text})` : text
}

export function propertyKey(property) {
    if (t.isStringLiteral(property.key)) return property.key.value
    if (t.isIdentifier(property.key) && !property.computed) return property.key.name
    return null
}

const builtinField = (name, type) => ({ name, type: named(type) })

const builtinEnums = () => new Map([
    ["Result", {
        members: new Set(["Ok", "Err"]), valueTypes: new Set(), typeParams: ["T", "E"], builtin: true,
        variants: new Map([["Ok", [builtinField("value", "T")]], ["Err", [builtinField("error", "E")]]])
    }],
    ["Option", {
        members: new Set(["Some", "None"]), valueTypes: new Set(), typeParams: ["T"], builtin: true,
        variants: new Map([["Some", [builtinField("value", "T")]], ["None", null]])
    }]
])

export function createEnvironment() {
    return {
        structs: new Map(),
        enums: builtinEnums(),
        customTypes: new Set(),
        customPredicates: new Map(),
        aliases: new Map(),
        genericAliases: new Map(),
        functions: new Map(),
        bindings: new Map(),
        classes: new Set(),
        classDefs: new Map(),
        methodOwners: new Map(),
        returns: new Map(),
        functionsByName: new Map(),
        importedFunctions: new Map(),
        importedValues: new Map(),
        importedLocals: new Set(),
        declaredValues: new Map(),
        declaredConstants: new Set(),
        openGlobals: false,
        functionPaths: new Map(),
        initTypes: new Map(),
        refinedTypes: new Map(),
        inferredReturns: new Map(),
        inferring: new Set(),
        facts: [],
        memberWrites: new Map(),
        ambientNames: new Map(),
        inferCache: new WeakMap(),
        siblingFacts: new WeakMap(),
        pending: new Set(),
        taint: 0
    }
}

export function atoms(type, env, seen = new Set()) {
    if (type.kind === "generic" && env.genericAliases?.has(type.name)) {
        const key = formatType(type)
        if (seen.has(key) || seen.size > 24) return []
        const found = atoms(expandAlias(type, env), env, new Set(seen).add(key))
        return found.length || seen.size ? found : [type]
    }
    if (type.kind === "named" && env.aliases.has(type.name)) {
        if (seen.has(type.name)) return []
        const found = atoms(env.aliases.get(type.name), env, new Set(seen).add(type.name))
        return found.length || seen.size ? found : [type]
    }
    if (type.kind === "union") return type.types.flatMap(part => atoms(part, env, seen))
    if (type.kind === "keyof" || type.kind === "index") {
        const key = formatType(type)
        if (seen.has(key) || seen.size > 24) return [type]
        const resolved = type.kind === "keyof" ? keysOf(type.type, env) : indexedType(type.object, type.index, env)
        return resolved ? atoms(resolved, env, new Set(seen).add(key)) : [type]
    }
    return [type]
}

export function keysOf(type, env) {
    const atom = single(type, env)
    if (!atom) return null
    if (atom.kind === "generic" && atom.name === "Record") return atom.args[0] ?? STRING
    const definition = structFor(atom, env) ?? classFor(atom, env)
    if (!definition || definition.open) return null
    const names = [...definition.fields.keys(), ...(definition.methods?.keys() ?? [])]
    return names.length ? unionOf([...new Set(names)].map(name => literal(name))) : named("never")
}

function fieldOf(definition, name) {
    const field = definition.fields.get(name)
    if (field) return field.optional ? unionOf([field.type, UNDEFINED]) : field.type
    return definition.methods?.has(name) ? FUNCTION : null
}

export function indexedType(object, index, env) {
    const atom = single(object, env)
    if (!atom) return null
    const keys = atoms(index, env)
    if (keys.some(key => key.kind === "keyof" || key.kind === "index" || key.kind === "any")) {
        const own = keys.length === 1 && keys[0].kind === "keyof" && formatType(keys[0].type) === formatType(atom) ? keysOf(atom, env) : null
        if (!own) return null
        return indexedType(atom, own, env)
    }
    if (atom.kind === "generic" && atom.name === "Record") return atom.args[1] ?? ANY
    if (atom.kind === "tuple" && keys.every(key => key.kind === "literal" && Number.isInteger(key.value))) {
        const items = keys.map(key => atom.items[key.value])
        return items.every(Boolean) ? unionOf(items) : null
    }
    if (isArrayLike(atom) && keys.every(key => isNumeric(key) || (key.kind === "literal" && typeof key.value === "number"))) {
        return atom.kind === "array" ? atom.element : atom.kind === "tuple" ? unionOf(atom.items) : ANY
    }
    const definition = structFor(atom, env) ?? classFor(atom, env)
    if (!definition || !keys.every(key => key.kind === "literal")) return null
    const types = keys.map(key => fieldOf(definition, String(key.value)))
    return types.every(Boolean) ? unionOf(types) : null
}

export function expandAlias(type, env) {
    const { params, body, defaults = [] } = env.genericAliases.get(type.name)
    const bound = new Map()
    params.forEach((param, index) => {
        const fallback = defaults[index]
        bound.set(param, type.args[index] ?? (fallback ? substituteType(fallback, bound) : ANY))
    })
    return substituteType(body, bound)
}

export function single(type, env) {
    const all = atoms(type, env)
    return all.length === 1 ? all[0] : null
}

export const traitName = label => readType(label).name ?? label

export function boundParams(definition, args) {
    const bound = new Map()
    for (const [index, param] of (definition?.typeParams ?? []).entries()) {
        const fallback = definition.typeDefaults?.get(param)
        bound.set(param, args[index] ?? (fallback ? substituteType(fallback, bound) : ANY))
    }
    return bound
}

export function enumVariants(atom, env) {
    if (atom.kind !== "named" && atom.kind !== "generic" && atom.kind !== "enumMember") return null
    const definition = env.enums.get(atom.name)
    if (!definition?.variants) return null
    const args = atom.kind === "generic" ? atom.args : atom.args ?? []
    const bound = boundParams(definition, args)
    const tags = atom.kind === "enumMember" ? [atom.member] : [...definition.variants.keys()]
    return { definition, tags, bound, args }
}

export function variantField(atom, name, env) {
    const variants = enumVariants(atom, env)
    if (!variants) return null
    const owners = []
    const missing = []
    const types = []
    for (const tag of variants.tags) {
        const field = variants.definition.variants.get(tag)?.find(item => item.name === name)
        if (field) {
            owners.push(tag)
            types.push(variants.bound.size ? substituteType(field.type, variants.bound) : field.type)
        } else missing.push(tag)
    }
    return { owners, missing, type: types.length && missing.length === 0 ? unionOf(types) : null, variants }
}

export function enumImplements(target, source, env) {
    const trait = env.structs.get(target.name)
    return !!trait?.trait && (env.enums.get(source.name)?.traits ?? []).some(label => traitName(label) === target.name)
}

function classFitsTrait(target, source, env) {
    const trait = env.structs.get(target.name)
    if (!trait?.trait || !knownClass(source.name, env)) return false
    const definition = classFor(named(source.name), env)
    if (definition.open) return true
    return [...trait.fields].every(([name, field]) => field.optional || definition.members.has(name)) &&
        [...trait.required].every(name => definition.members.has(name))
}

const prototypeMembers = value => {
    const names = new Set()
    for (let proto = Object.getPrototypeOf(value); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
        for (const name of Object.getOwnPropertyNames(proto)) if (name !== "constructor") names.add(name)
    }
    return names
}

const PRIMITIVE_MEMBERS = {
    string: { fields: new Map([["length", named("int")]]), methods: prototypeMembers("") },
    array: { fields: new Map([["length", named("int")]]), methods: prototypeMembers([]) },
    number: { fields: new Map(), methods: prototypeMembers(0) },
    bool: { fields: new Map(), methods: prototypeMembers(true) }
}

function primitiveKind(atom) {
    if (isArrayLike(atom)) return "array"
    if (atom.kind === "literal") return typeof atom.value === "string" ? "string" : typeof atom.value === "boolean" ? "bool" : "number"
    if (atom.kind !== "named") return null
    if (atom.name === "string") return "string"
    if (atom.name === "bool") return "bool"
    return NUMERIC.has(atom.name) ? "number" : null
}

function primitiveFitsTrait(target, source, env) {
    if (!env.structs.get(target.name)?.trait) return false
    const kind = primitiveKind(source)
    const wanted = kind && structFor(target, env)
    if (!wanted) return false
    const { fields, methods } = PRIMITIVE_MEMBERS[kind]
    const fitsField = ([name, field]) => {
        if (fields.has(name)) return accepts(field.type, fields.get(name), env)
        if (methods.has(name)) return isFunctionLike(single(field.type, env) ?? ANY)
        return field.optional
    }
    return [...wanted.fields].every(fitsField) && [...(wanted.required ?? [])].every(name => methods.has(name) || fields.has(name))
}

const fitting = new Set()

function traitFitsTrait(target, source, env) {
    const wanted = env.structs.get(target.name)
    const given = env.structs.get(source.name)
    if (!wanted?.trait || !given?.trait) return false
    const pair = source.name + ":" + target.name
    if (fitting.has(pair)) return true
    fitting.add(pair)
    try {
        return [...wanted.fields].every(([name, field]) => given.fields.has(name)
            ? accepts(field.type, given.fields.get(name).type, env)
            : field.optional) && [...wanted.required].every(name => given.methods.has(name) || given.fields.has(name))
    } finally {
        fitting.delete(pair)
    }
}

function traitDefaults(definition, env) {
    const defaults = []
    for (const name of (definition.traits ?? []).map(traitName)) {
        const trait = env.structs.get(name)
        if (!trait?.trait) continue
        for (const [method, signature] of trait.methods) if (!trait.required.has(method)) defaults.push([method, signature])
    }
    return defaults
}

export function resolveStruct(name, env, seen = new Set()) {
    const definition = env.structs.get(name)
    if (!definition) return null
    if (definition.resolved) return definition

    const traits = (definition.traits ?? []).map(traitName).filter(trait => env.structs.get(trait)?.trait)
    if (!definition.parent) {
        return {
            ...definition,
            methods: new Map([...traitDefaults(definition, env), ...definition.methods]),
            ancestors: new Set(traits),
            resolved: true
        }
    }
    if (seen.has(name)) return null

    seen.add(name)
    const parent = resolveStruct(definition.parent, env, seen)
    if (!parent) return null

    const fields = new Map(parent.fields)
    for (const [field, info] of definition.fields) fields.set(field, info)

    return {
        fields,
        defaults: new Set([...parent.defaults, ...definition.defaults]),
        methods: new Map([...parent.methods, ...traitDefaults(definition, env), ...definition.methods]),
        typeParams: definition.typeParams,
        traits: definition.traits,
        ancestors: new Set([definition.parent, ...parent.ancestors, ...traits]),
        parent: null,
        resolved: true
    }
}

function shapeDefinition(atom) {
    return {
        fields: new Map(atom.fields.map(field => [field.name, { type: field.type, optional: field.optional, readonly: false }])),
        defaults: new Set(), methods: new Map(), ancestors: new Set(), parent: null, typeParams: [],
        resolved: true, shape: true, exact: !!atom.exact, open: !!atom.open, label: `{ ${atom.fields.map(field => field.name + (field.optional ? "?" : "")).join(", ")} }`
    }
}

export function structFor(type, env) {
    const atom = type && single(type, env)
    if (atom?.kind === "shape") return shapeDefinition(atom)
    if (!atom || (atom.kind !== "named" && atom.kind !== "generic")) return null

    const definition = resolveStruct(atom.name, env)
    if (!definition) return null
    if (atom.kind !== "generic" || !definition.typeParams?.length) return { ...definition, label: formatType(atom) }

    const bound = boundParams(definition, atom.args)
    const fields = new Map()
    for (const [name, field] of definition.fields) fields.set(name, { ...field, type: substituteType(field.type, bound) })
    return { ...definition, fields, label: formatType(atom), bound }
}

export function ownerType(name, env) {
    const params = (env.structs.get(name) ?? env.enums.get(name))?.typeParams ?? []
    return params.length ? genericOf(name, params.map(named)) : named(name)
}

export function receiverThis(atom) {
    if (!atom) return null
    return atom.kind === "enumMember" ? named(atom.name) : atom
}

export function withThis(type, self) {
    return type && self ? substituteType(type, new Map([["this", self]])) : type
}

export function mentionsThis(type) {
    return !!type && typeNames(type).includes("this")
}

export function classFor(type, env) {
    const atom = type && single(type, env)
    if (atom?.kind !== "named") return null
    let definition = env.classDefs.get(atom.name)
    if (!definition) return null
    const fields = new Map()
    const methods = new Map()
    const members = new Set()
    const rebound = new Set()
    const seen = new Set()
    const chain = []
    let open = false
    while (definition && !seen.has(definition)) {
        seen.add(definition)
        chain.unshift(definition)
        if (definition.open) open = true
        const parent = definition.parent
        definition = parent ? env.classDefs.get(parent) : null
        if (parent && !definition) open = true
    }
    for (const link of chain) {
        for (const [name, field] of link.fields) fields.set(name, field)
        for (const [name, method] of link.methods) methods.set(name, method)
        for (const name of link.members ?? []) members.add(name)
        for (const name of link.rebound ?? []) rebound.add(name)
    }
    return { label: atom.name, fields, methods, members, rebound, open, isClass: true }
}

export function classDefinitionOf(node, path_, env) {
    if (!t.isIdentifier(node)) return null
    const binding = path_.scope.getBinding(node.name)
    if (!binding && env.importedLocals.has(node.name) && env.classes.has(node.name) && env.classDefs.has(node.name)) {
        return { name: node.name, definition: env.classDefs.get(node.name) }
    }
    if (!binding || binding.constantViolations.length) return null
    const declared = binding.path.isClassDeclaration() || (binding.path.isVariableDeclarator() && t.isClassExpression(binding.path.node.init))
    if (!declared || !env.classDefs.has(node.name)) return null
    return { name: node.name, definition: env.classDefs.get(node.name) }
}

export function classChain(name, env) {
    const chain = []
    const seen = new Set()
    while (name && !seen.has(name)) {
        seen.add(name)
        const definition = env.classDefs.get(name)
        if (!definition) return null
        chain.push(definition)
        name = definition.parent
    }
    return chain
}

export function staticSignature(object, method, path_, env) {
    const found = classDefinitionOf(object, path_, env)
    if (!found) return null
    for (const definition of classChain(found.name, env) ?? []) {
        if (definition.openStatics) return null
        const member = definition.statics.get(method)
        if (member) return member.method ? { name: found.name, signature: member.signature ?? null } : null
    }
    return null
}

function inherits(name, ancestor, env) {
    if (name === ancestor) return true
    return resolveStruct(name, env)?.ancestors.has(ancestor) ?? false
}

function knownClass(name, env) {
    return env.classDefs.has(name) && !env.aliases.has(name) && !env.customTypes.has(name)
}

function classInherits(name, ancestor, env) {
    const seen = new Set()
    while (name && !seen.has(name)) {
        if (name === ancestor) return true
        seen.add(name)
        name = env.classDefs.get(name)?.parent ?? null
    }
    return false
}

export function isOpen(type, env) {
    switch (type.kind) {
        case "any":
        case "intersection":
            return true
        case "named":
            if (env.customTypes.has(type.name)) return true
            if (type.name === "Struct" && !env.structs.has("Struct")) return false
            return !(KNOWN.has(type.name) || BUILTIN_CLASSES.has(type.name) || env.structs.has(type.name) || env.enums.has(type.name) || knownClass(type.name, env))
        case "generic":
            if (type.name === "Record" || isStructType(type, env) || env.genericAliases?.has(type.name)) return false
            return env.customTypes.has(type.name) || !(env.structs.has(type.name) || BUILTIN_CLASSES.has(type.name) || env.enums.has(type.name))
        case "enumMember":
            return !env.enums.has(type.name)
        case "keyof":
        case "index":
            return true
    }
    return false
}

export const isStructType = (type, env) => (type.kind === "named" || type.kind === "generic") && type.name === "Struct" && !env.structs.has("Struct")
export const isArrayLike = type => type.kind === "array" || type.kind === "tuple" || isNamed(type, "array")
const isFunctionLike = type => type.kind === "function" || isNamed(type, "function")

export function functionParamType(atom, index, env) {
    const params = atom.params
    const own = params[index]
    if (own && !own.rest) return own.type
    const last = params.at(-1)
    if (!last?.rest || index < params.length - 1) return null
    const list = single(last.type, env)
    return list?.kind === "array" ? list.element : list?.kind === "tuple" ? list.items[index - params.length + 1] ?? null : ANY
}

function acceptsFunction(target, source, env) {
    if (!isFunctionLike(target)) return isOpen(target, env)
    if (!isFunctionLike(source)) return isOpen(source, env)
    if (target.kind !== "function" || source.kind !== "function") return true

    const paramAt = (params, index) => functionParamType({ params }, index, env)
    const count = source.params.at(-1)?.rest ? Math.max(source.params.length, target.params.length) : source.params.length
    const paramsFit = Array.from({ length: count }, (_, index) => index).every(index => {
        const wanted = paramAt(source.params, index)
        const given = paramAt(target.params, index)
        return !wanted || !given || accepts(wanted, given, env)
    })
    const returnsFit = isNamed(target.returns, "undefined") || accepts(target.returns, source.returns, env)
    return paramsFit && returnsFit
}

function acceptsShape(target, source, env) {
    const wanted = structFor(target, env)
    const given = structFor(source, env)
    if (!wanted) return isNamed(target, "object") || isOpen(target, env)
    if (!given) return isNamed(source, "object") || isOpen(source, env)

    if (given.shape && !wanted.shape && !wanted.trait && wanted.methods.size > 0) return false
    const fieldType = field => field.optional ? unionOf([field.type, UNDEFINED]) : field.type
    for (const [name, field] of wanted.fields) {
        const other = given.fields.get(name)
        if (!other) {
            if (!field.optional && !(wanted.defaults.has(name) && given.shape && !given.exact)) return false
            continue
        }
        if (!accepts(fieldType(field), fieldType(other), env)) return false
    }
    if (wanted.trait) return [...wanted.required].every(name => given.fields.has(name))
    return [...given.fields.keys()].every(name => wanted.fields.has(name))
}

function acceptsRecord(target, source, env) {
    const [key = ANY, value = ANY] = target.args
    if (isNamed(source, "object") || isOpen(source, env)) return true
    if (source.kind === "generic" && source.name === "Record") {
        return accepts(key, source.args[0] ?? ANY, env) && accepts(value, source.args[1] ?? ANY, env)
    }
    const given = structFor(source, env)
    if (!given) return false
    const keys = atoms(key, env)
    const exact = keys.length > 0 && keys.every(atom => atom.kind === "literal")
    if (exact && keys.some(atom => !given.fields.has(String(atom.value)) || given.fields.get(String(atom.value)).optional)) return false
    return [...given.fields].every(([name, field]) =>
        accepts(key, literal(name), env) && accepts(value, field.optional ? unionOf([field.type, UNDEFINED]) : field.type, env))
}

export function exactRecordKeys(type, env) {
    const atom = type && single(type, env)
    if (atom?.kind !== "generic" || atom.name !== "Record") return null
    const keys = atoms(atom.args[0] ?? ANY, env)
    return keys.length > 0 && keys.every(key => key.kind === "literal") ? keys.map(key => key.value) : null
}

function sameDefinition(target, source, env) {
    for (const table of [env.structs, env.enums, env.classDefs]) {
        const definition = table.get(target)
        if (definition) return definition === table.get(source)
    }
    return false
}

export function acceptsAtom(target, source, env) {
    if (isNever(source)) return true
    if (isNever(target)) return false
    if (isMarkupType(source)) return isMarkupType(target) || isNamed(target, "object")
    if (isStructType(target, env)) {
        if (!isStructType(source, env)) return isOpen(source, env)
        const [wanted] = target.args ?? []
        const [given] = source.args ?? []
        return !wanted || !given || accepts(wanted, given, env)
    }
    if (isStructType(source, env)) return isNamed(target, "object") || isOpen(target, env)
    if (source.kind === "shape" && target.kind === "generic" && target.name === "Record") return acceptsRecord(target, source, env)
    if (target.kind === "shape" || source.kind === "shape") {
        if (isArrayLike(target) || isArrayLike(source) || isFunctionLike(target) || isFunctionLike(source)) return isOpen(target, env) || isOpen(source, env)
        return acceptsShape(target, source, env)
    }
    if (source.kind === "literal") {
        if (target.kind === "literal") return target.value === source.value
        const values = (target.kind === "named" || target.kind === "enumMember") && env.enums.get(target.name)?.values
        if (values) return target.kind === "enumMember" ? values.get(target.member) === source.value : [...values.values()].includes(source.value)
        return acceptsAtom(target, literalBase(source), env)
    }
    if (isFunctionLike(target) || isFunctionLike(source)) return acceptsFunction(target, source, env)

    if (target.kind === "literal") {
        const base = literalBase(target)
        return isNamed(source, base.name) || (isNumeric(base) && isNumeric(source)) || isOpen(source, env)
    }

    if ((target.kind === "array" || target.kind === "tuple") && source.readonly && !target.readonly) return false
    if (target.kind === "array") {
        if (source.kind === "array") return isNamed(source.element, "null") || accepts(target.element, source.element, env)
        if (source.kind === "tuple") return source.items.every(item => accepts(target.element, item, env))
        return isNamed(source, "array") || isOpen(source, env)
    }
    if (target.kind === "tuple") {
        if (source.kind === "tuple") {
            return source.items.length === target.items.length &&
                target.items.every((item, index) => accepts(item, source.items[index], env))
        }
        return source.kind === "array" || isNamed(source, "array") || isOpen(source, env)
    }
    if (isNamed(target, "array")) return isArrayLike(source) || isOpen(source, env)
    if ((target.kind === "named" || target.kind === "generic") && primitiveFitsTrait(target, source, env)) return true
    if (isArrayLike(source)) return isNamed(target, "object") || isOpen(target, env)

    if (isOpen(target, env) || isOpen(source, env)) return true

    if (isNamed(target, "enum")) {
        if (source.kind === "enumMember") return true
        return (source.kind === "named" || source.kind === "generic") && (source.name === "enum" || env.enums.has(source.name))
    }

    if (isNumeric(target) && isNumeric(source)) return target.name !== "int" || source.name === "int"

    if (target.kind === "generic" && target.name === "Record") return acceptsRecord(target, source, env)
    if (target.kind === "generic") {
        const sameArgs = () => target.args.every((arg, index) => !source.args?.[index] || accepts(arg, source.args[index], env))
        if (env.structs.has(target.name)) {
            if (isNamed(source, "object") || classFitsTrait(target, source, env)) return true
            if (source.kind === "generic" && source.name === target.name) return sameArgs()
            return (source.kind === "named" || source.kind === "generic") && inherits(source.name, target.name, env)
        }
        if (source.kind === "generic") return source.name === target.name && sameArgs()
        if (env.enums.has(target.name)) return (source.kind === "named" || source.kind === "enumMember") && source.name === target.name
        return source.kind === "named" && source.name === target.name
    }
    if (source.kind === "generic") {
        if (target.kind === "named" && target.name === source.name) return true
        if (enumImplements(target, source, env)) return true
        return isNamed(target, "object") && (env.structs.has(source.name) || source.name === "Record")
    }

    if (target.kind === "enumMember") {
        if (source.kind === "enumMember") return source.name === target.name && source.member === target.member
        return source.name === target.name || env.enums.get(target.name).valueTypes.has(source.name)
    }
    if (env.enums.has(target.name)) {
        if (source.kind === "enumMember") return source.name === target.name
        return source.name === target.name || env.enums.get(target.name).valueTypes.has(source.name)
    }
    if (enumImplements(target, source, env) || classFitsTrait(target, source, env) || traitFitsTrait(target, source, env)) return true
    if (source.kind === "enumMember") return false

    if (target.name === source.name) return true
    if (sameDefinition(target.name, source.name, env)) return true
    if (BUILTIN_CLASSES.has(target.name) || BUILTIN_CLASSES.has(source.name)) return false
    if (target.name === "object") return env.structs.has(source.name) || knownClass(source.name, env)
    if (env.structs.has(target.name)) return source.name === "object" || inherits(source.name, target.name, env)
    if (knownClass(target.name, env)) return source.name === "object" || classInherits(source.name, target.name, env)
    return false
}

const comparing = new Set()
let comparingDepth = 0

export function accepts(target, source, env) {
    if (!target || !source) return true
    if (comparingDepth < 6) {
        comparingDepth++
        try {
            return acceptsAll(target, source, env)
        } finally {
            comparingDepth--
        }
    }
    const key = formatType(target) + "\u0000" + formatType(source)
    if (comparing.has(key)) return true
    if (comparingDepth > 200) return false
    comparing.add(key)
    comparingDepth++
    try {
        return acceptsAll(target, source, env)
    } finally {
        comparingDepth--
        comparing.delete(key)
    }
}

function acceptsAll(target, source, env) {
    const targets = atoms(target, env)
    if (targets.some(atom => atom.kind === "any" || atom.kind === "intersection")) return true

    return atoms(source, env).every(atom =>
        atom.kind === "any" || atom.kind === "intersection" || isNever(atom) || targets.some(other => acceptsAtom(other, atom, env)))
}

export function typeNames(type, found = []) {
    switch (type.kind) {
        case "named":
        case "enumMember":
            found.push(type.name)
            break
        case "generic":
            found.push(type.name)
            type.args.forEach(arg => typeNames(arg, found))
            break
        case "array":
            typeNames(type.element, found)
            break
        case "function":
            type.params.forEach(param => typeNames(param.type, found))
            typeNames(type.returns, found)
            break
        case "tuple":
        case "union":
        case "intersection":
            (type.items ?? type.types).forEach(part => typeNames(part, found))
            break
        case "shape":
            type.fields.forEach(field => typeNames(field.type, found))
            break
        case "keyof":
            typeNames(type.type, found)
            break
        case "index":
            typeNames(type.object, found)
            typeNames(type.index, found)
    }
    return found
}

function templateText(node) {
    let text = "`"
    for (const [index, quasi] of node.quasis.entries()) {
        text += quasi.value.raw
        if (index < node.expressions.length) {
            const inner = sourceText(node.expressions[index])
            if (!inner) return null
            text += "${" + inner + "}"
        }
    }
    return text + "`"
}

export function sourceText(node) {
    if (t.isIdentifier(node)) return node.name
    if (t.isThisExpression(node)) return "this"
    if ((t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) && !node.computed && t.isIdentifier(node.property)) {
        const object = sourceText(node.object)
        return object && `${object}${node.optional ? "?." : "."}${node.property.name}`
    }
    if ((t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) && node.computed) {
        const object = sourceText(node.object)
        const property = node.property
        const key = t.isStringLiteral(property) ? JSON.stringify(property.value) : t.isNumericLiteral(property) ? String(property.value)
            : t.isTemplateLiteral(property) ? templateText(property) : sourceText(property)
        return object && key && `${object}${node.optional ? "?." : ""}[${key}]`
    }
    if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
        const callee = sourceText(node.callee)
        return callee && `${callee}(...)`
    }
    return null
}
