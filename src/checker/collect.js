import _traverse from "@babel/traverse"
import * as t from "@babel/types"
import { ANY, genericOf, named, readType, substituteType, unionOf } from "../external/typeSyntax.js"
import { UNDEFINED, ownerType, propertyKey, withThis } from "./core.js"
import { collectParameters, typedVariableLabel } from "./infer.js"
import { refKey } from "./narrowing.js"
import { describePredicate } from "./predicates.js"
import { collectJsonImport } from "./json.js"

const traverse = _traverse.default ?? _traverse

function functionName(path_) {
    if (t.isFunctionDeclaration(path_.node) && path_.node.id) return path_.node.id.name
    if (path_.parentPath?.isVariableDeclarator() && t.isIdentifier(path_.parent.id)) {
        return path_.parent.id.name
    }
    if (path_.parentPath?.isObjectProperty()) {
        const key = path_.parent.key
        if (t.isStringLiteral(key)) return key.value
        if (t.isIdentifier(key)) return key.name
    }
    if ((t.isClassMethod(path_.node) || t.isObjectMethod(path_.node)) && t.isIdentifier(path_.node.key)) {
        return path_.node.key.name
    }
    return "function"
}

function collectStruct(init, env) {
    const [nameArg, schema] = init.arguments
    const fields = new Map()
    for (const property of schema.properties) {
        if (!t.isObjectProperty(property) || !t.isStringLiteral(property.value)) continue
        const key = propertyKey(property)
        if (key === null) continue
        const optional = key.startsWith("*")
        fields.set(optional ? key.slice(1).trim() : key, { type: readType(property.value.value), optional, readonly: false })
    }

    if (t.isArrayExpression(init.arguments[7])) {
        for (const element of init.arguments[7].elements) {
            if (t.isStringLiteral(element) && fields.has(element.value)) fields.get(element.value).readonly = true
        }
    }

    const typeParams = t.isArrayExpression(init.arguments[6])
        ? init.arguments[6].elements.filter(element => t.isStringLiteral(element)).map(element => element.value)
        : []

    const defaults = new Set()
    if (t.isObjectExpression(init.arguments[3])) {
        for (const property of init.arguments[3].properties) {
            if (!t.isObjectProperty(property)) continue
            const key = propertyKey(property)
            if (key !== null) defaults.add(key)
        }
    }

    const methods = new Map()
    if (t.isObjectExpression(init.arguments[5])) {
        for (const property of init.arguments[5].properties) {
            if (!t.isObjectProperty(property)) continue
            const key = propertyKey(property)
            if (key === null) continue
            const isFunction = t.isFunction(property.value)
            methods.set(key, isFunction ? collectParameters(property.value) : null)
            if (isFunction) env.methodOwners.set(property.value, nameArg.value)
        }
    }

    const parent = t.isStringLiteral(init.arguments[4]) ? init.arguments[4].value : null
    const traits = t.isArrayExpression(init.arguments[8]) ? init.arguments[8].elements.map(element => element.value) : []
    const constraints = new Map(Object.entries(init._slimConstraints ?? {}).map(([name, label]) => [name, readType(label)]))
    const self = typeParams.length ? genericOf(nameArg.value, typeParams.map(named)) : named(nameArg.value)
    for (const field of fields.values()) field.type = withThis(field.type, self)
    env.structs.set(nameArg.value, { fields, defaults, methods, parent, typeParams, traits, constraints, typeDefaults: typeDefaults(init) })
}

function patternTargets(target, names) {
    if (t.isMemberExpression(target) && t.isThisExpression(target.object)) {
        if (target.computed && !t.isStringLiteral(target.property)) names.open = true
        else names.add(t.isStringLiteral(target.property) ? target.property.value : target.property.name)
    } else if (t.isArrayPattern(target)) target.elements.forEach(element => patternTargets(element, names))
    else if (t.isObjectPattern(target)) target.properties.forEach(property => patternTargets(t.isRestElement(property) ? property.argument : property.value, names))
    else if (t.isAssignmentPattern(target)) patternTargets(target.left, names)
    else if (t.isRestElement(target)) patternTargets(target.argument, names)
}

function thisWrites(node, names) {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node)) return node.forEach(child => thisWrites(child, names))
    if (t.isFunctionExpression(node) || t.isFunctionDeclaration(node) || t.isClass(node) || t.isObjectMethod(node)) return
    if (t.isAssignmentExpression(node)) patternTargets(node.left, names)
    if (t.isCallExpression(node) && t.isMemberExpression(node.callee) && t.isIdentifier(node.callee.object, { name: "Object" }) &&
        t.isThisExpression(node.arguments[0])) names.open = true
    for (const key in node) {
        if (key === "loc" || key === "extra" || key.startsWith("_")) continue
        const child = node[key]
        if (child && typeof child === "object") thisWrites(child, names)
    }
}

function collectClass(node, name, env) {
    const fields = new Map()
    const methods = new Map()
    const getters = new Set()
    const setters = new Set()
    const members = new Set()
    const statics = new Map()
    let construct = null
    let open = !!node.superClass && !t.isIdentifier(node.superClass)
    let openStatics = false
    for (const member of node.body.body) {
        if (t.isStaticBlock(member)) {
            openStatics = true
            continue
        }
        if (member.static) {
            if (member.computed) openStatics = true
            else if (t.isIdentifier(member.key) && (t.isClassProperty(member) || t.isClassMethod(member))) {
                statics.set(member.key.name, t.isClassProperty(member)
                    ? { type: member._slimField ? readType(member._slimField.type) : null, method: false }
                    : { type: null, method: true, signature: member.kind === "method" ? collectParameters(member) : null })
            }
            continue
        }
        if (t.isClassMethod(member, { kind: "constructor" })) construct = collectParameters(member)
        if (member.computed || t.isClassPrivateProperty(member) || t.isClassPrivateMethod(member)) {
            if (member.computed) open = true
            continue
        }
        if (!t.isIdentifier(member.key) && !t.isStringLiteral(member.key)) continue
        const key = t.isIdentifier(member.key) ? member.key.name : member.key.value
        members.add(key)
        if (t.isClassMethod(member) || t.isClassProperty(member)) {
            const names = new Set()
            thisWrites(t.isClassMethod(member) ? member.body : member.value, names)
            if (names.open) open = true
            for (const written of names) members.add(written)
        }
        if (!t.isIdentifier(member.key)) continue
        if (t.isClassProperty(member) && member._slimField) {
            const { type, optional, readonly } = member._slimField
            fields.set(member.key.name, { type: withThis(readType(type), named(name)), optional, readonly })
        } else if (t.isClassMethod(member)) {
            env.methodOwners.set(member, name)
            if (member.kind === "method") methods.set(member.key.name, collectParameters(member))
            else if (member.kind === "get" && !fields.has(member.key.name)) {
                getters.add(member.key.name)
                fields.set(member.key.name, { type: collectParameters(member).returns ?? ANY, optional: false, readonly: false })
            } else if (member.kind === "set") setters.add(member.key.name)
        }
    }
    for (const getter of getters) {
        if (!setters.has(getter)) fields.get(getter).readonly = true
    }
    const parent = t.isIdentifier(node.superClass) ? node.superClass.name : null
    if (env.classDefs.has(name)) open = true
    if (env.enums.get(name)?.builtin) env.enums.delete(name)
    env.classDefs.set(name, { fields, methods, parent, members, open, statics, openStatics, construct })
}

function collectTrait(init, env) {
    const [nameArg, schema, required, defaults, params] = init.arguments
    const fields = new Map()
    for (const property of schema.properties) {
        const key = t.isObjectProperty(property) && t.isStringLiteral(property.value) ? propertyKey(property) : null
        if (key === null) continue
        const optional = key.startsWith("*")
        fields.set(optional ? key.slice(1).trim() : key, { type: readType(property.value.value), optional, readonly: false })
    }
    const methods = new Map()
    const requiredNames = new Set()
    for (const [group, isRequired] of [[required, true], [defaults, false]]) {
        if (!t.isObjectExpression(group)) continue
        for (const property of group.properties) {
            const key = t.isObjectProperty(property) && t.isFunction(property.value) ? propertyKey(property) : null
            if (key === null) continue
            methods.set(key, collectParameters(property.value))
            env.methodOwners.set(property.value, nameArg.value)
            if (isRequired) requiredNames.add(key)
        }
    }
    env.structs.set(nameArg.value, {
        fields, defaults: new Set(), methods, parent: null, trait: true, required: requiredNames,
        typeParams: t.isArrayExpression(params) ? params.elements.map(param => param.value) : [],
        typeDefaults: typeDefaults(init)
    })
}

function componentSignature(name, props, env) {
    let type
    let required = false
    if (props.type) {
        type = readType(props.type)
        required = true
    } else {
        const key = `${name} props`
        const fields = new Map(props.fields.map(field =>
            [field.name, { type: field.type ? readType(field.type) : ANY, optional: field.optional, readonly: true }]))
        env.structs.set(key, { fields, defaults: new Set(), methods: new Map(), parent: null, typeParams: [], component: name })
        type = named(key)
        required = props.fields.some(field => !field.optional)
    }
    return {
        parameters: [{ name: "props", type, required }],
        rest: false, returns: null, async: false, typed: true, node: null, typeParams: []
    }
}

function collectVariants(init, env) {
    const [nameArg, schema, params, methodsArg, traitsArg] = init.arguments
    const variants = new Map()
    for (const property of schema.properties) {
        const key = t.isObjectProperty(property) ? propertyKey(property) : null
        if (key === null) continue
        variants.set(key, t.isArrayExpression(property.value)
            ? property.value.elements.map(field => ({ name: field.elements[0].value, type: readType(field.elements[1].value) }))
            : null)
    }
    const typeParams = t.isArrayExpression(params) ? params.elements.map(param => param.value) : []
    const methods = new Map()
    if (t.isObjectExpression(methodsArg)) {
        for (const property of methodsArg.properties) {
            const key = t.isObjectProperty(property) && t.isFunction(property.value) ? propertyKey(property) : null
            if (key === null) continue
            methods.set(key, collectParameters(property.value))
            env.methodOwners.set(property.value, nameArg.value)
        }
    }
    const traits = t.isArrayExpression(traitsArg) ? traitsArg.elements.map(element => element.value) : []
    env.enums.set(nameArg.value, { members: new Set(variants.keys()), valueTypes: new Set(), variants, typeParams, methods, traits, typeDefaults: typeDefaults(init) })
}

function collectEnum(init, env) {
    const [nameArg, schema] = init.arguments
    const members = new Set()
    const valueTypes = new Set()
    let values = new Map()
    for (const property of schema.properties) {
        if (!t.isObjectProperty(property)) continue
        const key = propertyKey(property)
        if (key !== null) members.add(key)
        if (t.isStringLiteral(property.value)) valueTypes.add("string")
        else if (t.isNumericLiteral(property.value)) {
            valueTypes.add(Number.isInteger(property.value.value) ? "int" : "float")
        } else valueTypes.add("any")
        if (values && key !== null && (t.isStringLiteral(property.value) || t.isNumericLiteral(property.value))) values.set(key, property.value.value)
        else values = null
    }
    env.enums.set(nameArg.value, { members, valueTypes, values })
}

function aliasGeneric(properties) {
    if (!t.isObjectExpression(properties)) return null
    const value = name => {
        const property = properties.properties.find(entry => t.isObjectProperty(entry) && propertyKey(entry) === name)
        return t.isStringLiteral(property?.value) ? property.value.value : null
    }
    const params = value("params")
    const body = value("generic")
    if (!params || !body) return null
    const names = params.split(",").map(param => param.trim()).filter(Boolean)
    const written = value("defaults")
    let labels = {}
    try {
        labels = written ? JSON.parse(written) : {}
    } catch {
        labels = {}
    }
    return { params: names, body: readType(body), defaults: names.map(name => typeof labels[name] === "string" ? readType(labels[name]) : null) }
}

function typeDefaults(node) {
    const labels = node._slimTypeDefaults
    if (!labels || typeof labels !== "object") return new Map()
    return new Map(Object.entries(labels).filter(([, label]) => typeof label === "string").map(([name, label]) => [name, readType(label)]))
}

function recordWrite(target, path_, env) {
    if (!t.isMemberExpression(target)) return
    const key = refKey(target, path_)
    if (key) recordKey(key, target.start, env)
}

function recordGlobalWrite(target, path_, env) {
    for (const name of Object.keys(t.getBindingIdentifiers(target))) {
        if (path_.scope.getBinding(name)) continue
        const key = refKey(t.identifier(name), path_)
        if (key) recordKey(key, target.start, env)
    }
}

function recordKey(key, start, env) {
    if (!env.memberWrites.has(key)) env.memberWrites.set(key, [])
    env.memberWrites.get(key).push(start)
}

const REORDERING = new Set(["shift", "unshift", "splice", "pop", "reverse", "sort", "fill", "copyWithin"])

export function collect(ast, env) {
    traverse(ast, {
        ImportDeclaration(path_) {
            collectJsonImport(path_, env)
        },

        Class(path_) {
            const name = path_.node.id?.name ?? (path_.parentPath.isVariableDeclarator() && t.isIdentifier(path_.parent.id) ? path_.parent.id.name : null)
            if (!name) return
            if (path_.isClassDeclaration()) env.classes.add(name)
            collectClass(path_.node, name, env)
        },

        AssignmentExpression(path_) {
            recordWrite(path_.node.left, path_, env)
            recordGlobalWrite(path_.node.left, path_, env)
        },

        UpdateExpression(path_) {
            recordWrite(path_.node.argument, path_, env)
            recordGlobalWrite(path_.node.argument, path_, env)
        },

        UnaryExpression(path_) {
            if (path_.node.operator === "delete") recordWrite(path_.node.argument, path_, env)
        },

        CallExpression(path_) {
            const callee = path_.node.callee
            if (!t.isMemberExpression(callee) || callee.computed || !t.isIdentifier(callee.property) || !REORDERING.has(callee.property.name)) return
            const key = refKey(callee.object, path_)
            if (key) recordKey(`${key}[?]`, path_.node.start, env)
        },

        CatchClause(path_) {
            const param = path_.node.param
            if (!param?._slimCatchType) return
            const binding = path_.scope.getBinding(param.name)
            if (binding) env.bindings.set(binding, readType(param._slimCatchType))
        },

        VariableDeclarator(path_) {
            const { id, init } = path_.node
            if (!t.isIdentifier(id)) return

            const binding = path_.scope.getBinding(id.name)
            if (path_.node._slimType && binding) {
                env.bindings.set(binding, readType(path_.node._slimType))
                return
            }

            if (init?._slimComponentProps && binding) {
                const signature = componentSignature(id.name, init._slimComponentProps, env)
                env.functions.set(binding, signature)
                if (binding.scope.path.isProgram()) env.functionsByName.set(id.name, signature)
                return
            }

            if (t.isCallExpression(init) && t.isIdentifier(init.callee)) {
                const name = init.callee.name
                const [nameArg, schema] = init.arguments

                if (name === "__def_struct__" && t.isStringLiteral(nameArg) && t.isObjectExpression(schema)) {
                    collectStruct(init, env)
                    return
                }
                if (name === "__def_enum__" && t.isStringLiteral(nameArg) && t.isObjectExpression(schema)) {
                    collectEnum(init, env)
                    return
                }
                if (name === "__def_trait__" && t.isStringLiteral(nameArg) && t.isObjectExpression(schema)) {
                    collectTrait(init, env)
                    return
                }
                if (name === "__def_variants__" && t.isStringLiteral(nameArg) && t.isObjectExpression(schema)) {
                    collectVariants(init, env)
                    return
                }
                if (name === "__type_def__" && t.isStringLiteral(nameArg)) {
                    if (t.isStringLiteral(schema)) env.aliases.set(nameArg.value, readType(schema.value))
                    else {
                        env.customTypes.add(nameArg.value)
                        const predicate = describePredicate(schema, init.arguments[2])
                        if (predicate) env.customPredicates.set(nameArg.value, predicate)
                        else env.customPredicates.delete(nameArg.value)
                    }
                    const generic = aliasGeneric(init.arguments[2])
                    if (generic && t.isStringLiteral(schema)) env.genericAliases.set(nameArg.value, generic)
                    return
                }

                const label = typedVariableLabel(init)
                if (label && binding) env.bindings.set(binding, readType(label))
            }

            if ((t.isArrowFunctionExpression(init) || t.isFunctionExpression(init)) && binding) {
                const signature = collectParameters(init)
                env.functions.set(binding, signature)
                if (binding.scope.path.isProgram()) env.functionsByName.set(id.name, signature)
            }
        },

        FunctionDeclaration(path_) {
            if (!path_.node.id) return
            const name = path_.node.id.name
            const binding = path_.scope.getBinding(name)
            if (!binding) return

            const signature = collectParameters(path_.node)
            env.functions.set(binding, signature)
            if (binding.scope.path.isProgram()) env.functionsByName.set(name, signature)
        },

        Function(path_) {
            env.functionPaths.set(path_.node, path_)

            const { parameters, returns: declaredReturns, constraints, destructured } = collectParameters(path_.node)
            for (const { name, type, optional } of destructured) {
                const binding = path_.scope.getBinding(name)
                if (binding && binding.scope === path_.scope) env.bindings.set(binding, optional ? unionOf([type, UNDEFINED]) : type)
            }
            const owner = env.methodOwners.get(path_.node)
            const self = owner ? ownerType(owner, env) : null
            const returns = withThis(declaredReturns, self)
            parameters.forEach((parameter, index) => {
                if (!parameter.name || !parameter.type) return
                const binding = path_.scope.getBinding(parameter.name)
                if (!binding) return
                const own = withThis(parameter.type, self)
                const type = constraints.size ? substituteType(own, constraints) : own
                const missing = !parameter.required && t.isIdentifier(path_.node.params[index])
                env.bindings.set(binding, missing ? unionOf([type, UNDEFINED]) : type)
            })

            if (returns) {
                env.returns.set(path_.node, { type: returns, name: functionName(path_) })
            }
        }
    })
}
