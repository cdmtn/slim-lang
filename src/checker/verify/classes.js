import * as t from "@babel/types"
import { formatType, named, readType, substituteType, unionOf } from "../../external/typeSyntax.js"
import { didYouMean } from "../../suggest.js"
import { classChain, classDefinitionOf, classFor, ownerType, UNDEFINED, accepts, describe, mentionsThis, resolveStruct } from "../core.js"
import { collectParameters } from "../infer.js"
import { checkValue } from "./values.js"
import { checkCall } from "./calls.js"

function signatureText(signature) {
    const params = signature.parameters.map(param => param.type ? `${param.name}: ${formatType(param.type)}` : param.name).join(", ")
    return `(${params})${signature.returns ? ` -> ${formatType(signature.returns)}` : ""}`
}

function enumShape(name, env) {
    const definition = env.enums.get(name)
    if (!definition) return null
    const variants = [...definition.variants.values()]
    const fields = new Map()
    const [first] = variants
    for (const field of first ?? []) {
        const everywhere = variants.every(fieldsOf => fieldsOf?.some(other => other.name === field.name))
        if (everywhere) fields.set(field.name, { type: field.type, optional: false })
    }
    return { fields, methods: definition.methods ?? new Map() }
}

export function checkImplements(node, env, report) {
    const [nameArg] = node.arguments
    const isEnum = t.isIdentifier(node.callee, { name: "__def_variants__" })
    const list = node.arguments[isEnum ? 4 : 8]
    if (!t.isStringLiteral(nameArg) || !t.isArrayExpression(list)) return
    const struct = isEnum ? enumShape(nameArg.value, env) : resolveStruct(nameArg.value, env)
    if (!struct) return

    for (const element of list.elements) {
        const reference = readType(element.value)
        const traitName = reference.name
        const trait = env.structs.get(traitName)
        if (!trait?.trait) {
            const known = [...env.structs].filter(([, definition]) => definition.trait).map(([name]) => name)
            report(element, trait ? `"${traitName}" is a struct, not a trait` : `unknown trait "${traitName}"${didYouMean(traitName, known)}`)
            continue
        }
        const params = trait.typeParams ?? []
        const args = reference.kind === "generic" ? reference.args : []
        if (args.length !== params.length) {
            report(element, `trait "${traitName}" takes ${params.length} type argument${params.length === 1 ? "" : "s"}, got ${args.length}`)
            continue
        }
        const bound = new Map(params.map((param, index) => [param, args[index]]))
        bound.set("this", ownerType(nameArg.value, env))
        const bind = type => bound.size ? substituteType(type, bound) : type
        const bindSignature = signature => bound.size ? {
            ...signature,
            parameters: signature.parameters.map(param => ({ ...param, type: param.type && bind(param.type) })),
            returns: signature.returns && bind(signature.returns)
        } : signature
        for (const [field, rawInfo] of trait.fields) {
            const info = { ...rawInfo, type: bind(rawInfo.type) }
            const own = struct.fields.get(field)
            if (!own) {
                if (!info.optional) report(element, `"${nameArg.value}" needs field "${field}: ${formatType(info.type)}" for trait "${traitName}"`)
                continue
            }
            if (!accepts(info.type, own.type, env)) {
                report(element, `"${nameArg.value}.${field}" is ${describe(own.type)}, but trait "${traitName}" needs ${describe(info.type)}`)
            }
        }
        for (const method of trait.required) {
            const wanted = bindSignature(trait.methods.get(method))
            const own = struct.methods.get(method) && bindSignature(struct.methods.get(method))
            if (!own) {
                report(element, `"${nameArg.value}" doesn't implement "${method}${signatureText(wanted)}" from trait "${traitName}"`)
                continue
            }
            const needs = own.parameters.filter(param => param.required).length
            const fitsParams = needs <= wanted.parameters.length && own.parameters.every((param, index) =>
                !param.type || !wanted.parameters[index]?.type || accepts(param.type, wanted.parameters[index].type, env))
            const fitsReturn = !wanted.returns || !own.returns || accepts(wanted.returns, own.returns, env)
            if (!fitsParams || !fitsReturn) {
                report(element, `"${nameArg.value}.${method}${signatureText(own)}" doesn't match "${method}${signatureText(wanted)}" from trait "${traitName}"`)
            }
        }
    }
}

export function checkThisPlace(type, fn, node, env, report) {
    if (!mentionsThis(type)) return
    if (fn?.node.static) {
        report(node, `the "this" type means an instance, and a static method has none — write the class name instead`)
        return
    }
    if (!fn || !env.methodOwners.has(fn.node)) {
        report(node, `the "this" type only works in a method of a class, struct, enum or trait — write the type name instead`)
    }
}

export function checkThisReturn(path_, env, report) {
    const fn = path_.getFunctionParent()
    const value = path_.node.argument
    if (!fn || !t.isNewExpression(value) || !t.isClassMethod(fn.node) || !env.methodOwners.has(fn.node)) return
    if (!mentionsThis(collectParameters(fn.node).returns)) return
    const owner = env.methodOwners.get(fn.node)
    report(value, `"${functionNameOf(fn.node)}" must return this, but a new ${t.isIdentifier(value.callee) ? value.callee.name : "object"} is not this for a subclass of ${owner} — return this, or declare -> ${owner}`)
}

function functionNameOf(node) {
    return t.isIdentifier(node.key) ? node.key.name : "method"
}

function constructorOf(name, env) {
    const chain = classChain(name, env)
    if (!chain) return undefined
    for (const definition of chain) if (definition.construct) return definition.construct
    return null
}

export function checkConstruction(node, path_, env, report) {
    const found = classDefinitionOf(node.callee, path_, env)
    if (!found) return
    const signature = constructorOf(found.name, env)
    if (signature) {
        checkCall(signature, node, `new ${found.name}`, path_, env, report)
        return
    }
    if (signature === null && node.arguments.length > 0 && !node.arguments.some(argument => t.isSpreadElement(argument))) {
        report(node, `"${found.name}" has no constructor, so "new ${found.name}" takes no arguments, got ${node.arguments.length}`)
    }
}

export function checkSuperCall(node, path_, env, report) {
    if (!t.isSuper(node.callee)) return
    const classPath = path_.findParent(parent => parent.isClass())
    const parent = classPath?.node.superClass
    if (!t.isIdentifier(parent) || !env.classDefs.has(parent.name)) return
    const signature = constructorOf(parent.name, env)
    if (signature) checkCall(signature, node, `super (${parent.name})`, path_, env, report)
}

const FUNCTION_STATICS = new Set(["name", "length", "prototype", "call", "apply", "bind", "toString"])

function writtenStatic(object, name, path_) {
    const binding = path_.scope.getBinding(object.name)
    return !!binding && binding.referencePaths.some(reference => {
        const parent = reference.parentPath
        return parent.isMemberExpression() && !parent.node.computed && t.isIdentifier(parent.node.property, { name }) &&
            parent.parentPath.isAssignmentExpression() && parent.key === "left"
    })
}

function staticMemberOf(name, member, env) {
    const chain = classChain(name, env)
    if (!chain) return { open: true }
    for (const definition of chain) {
        if (definition.openStatics || definition.open) return { open: true }
        if (definition.statics.has(member)) return definition.statics.get(member)
    }
    return null
}

export function checkStaticMember(node, path_, env, report) {
    if (node.computed || !t.isIdentifier(node.property)) return false
    const found = classDefinitionOf(node.object, path_, env)
    if (!found) return false
    const name = node.property.name
    if (FUNCTION_STATICS.has(name)) return true
    const member = staticMemberOf(found.name, name, env)
    if (member?.open) return true
    const target = t.isAssignmentExpression(path_.parent) && path_.parent.left === node
    if (!member) {
        if (target || writtenStatic(node.object, name, path_)) return true
        const known = (classChain(found.name, env) ?? []).flatMap(definition => [...definition.statics.keys()])
        const instance = classFor(named(found.name), env)
        const hint = instance && (instance.fields.has(name) || instance.methods.has(name)) ? ` — "${name}" belongs to instances: call it on new ${found.name}(...)` : didYouMean(name, known)
        report(node.property, `"${found.name}" has no static member "${name}"${hint}`)
        return true
    }
    if (target && member.type && path_.parent.operator === "=") {
        checkValue(member.type, path_.parent.right, path_, env, report, `"${found.name}.${name}"`)
    }
    return true
}

export function checkClassField(target, value, objectType, path_, env, report) {
    const definition = classFor(objectType, env)
    const field = definition?.fields.get(target.property.name)
    if (!field) return
    const name = `"${definition.label}.${target.property.name}"`
    if (field.readonly) {
        const inConstructor = t.isThisExpression(target.object) && path_.getFunctionParent()?.node.kind === "constructor"
        if (!inConstructor) report(target, `${name} is readonly`)
        return
    }
    checkValue(field.optional ? unionOf([field.type, UNDEFINED]) : field.type, value, path_, env, report, name)
}

function assignedInConstructor(node, name) {
    const constructor = node.body.body.find(member => t.isClassMethod(member) && member.kind === "constructor")
    if (!constructor) return false
    let found = false
    const walk = value => {
        if (found || !value || typeof value !== "object") return
        if (Array.isArray(value)) return value.forEach(walk)
        if (t.isFunctionExpression(value) || t.isFunctionDeclaration(value) || t.isClass(value)) return
        if (t.isAssignmentExpression(value) && t.isMemberExpression(value.left) && t.isThisExpression(value.left.object) &&
            !value.left.computed && t.isIdentifier(value.left.property, { name })) {
            found = true
            return
        }
        for (const key in value) {
            if (key === "loc" || key === "extra" || key.startsWith("_")) continue
            const child = value[key]
            if (child && typeof child === "object") walk(child)
        }
    }
    walk(constructor.body)
    return found
}

export function checkClassFields(path_, env, report) {
    for (const member of path_.node.body.body) {
        if (!t.isClassProperty(member) || member.static || member.value || !member._slimField || member._slimField.optional || member._slimField.setLater) continue
        if (!t.isIdentifier(member.key)) continue
        const type = readType(member._slimField.type)
        if (accepts(type, UNDEFINED, env) || assignedInConstructor(path_.node, member.key.name)) continue
        report(member, `"${member.key.name}" is ${describe(type)} but has no starting value — give it one, set it in the constructor, or mark it "${member.key.name}?:"`)
    }
}
