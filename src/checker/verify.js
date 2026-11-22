import _traverse from "@babel/traverse"
import * as t from "@babel/types"
import { ANY, genericOf, named, readType, unionOf } from "../external/typeSyntax.js"
import { didYouMean } from "../suggest.js"
import { classFor, UNDEFINED, accepts, atoms, describe, enumVariants, mentionsThis, receiverThis, isNullish, single, sourceText, staticSignature, structFor } from "./core.js"
import { enumMethod, infer, matchExpression, signatureFor, structLiteralName, typedVariableLabel, signatureOfType } from "./infer.js"
import { checkMarkup } from "./markup.js"
import { checkNewStruct, checkStructDefaults, checkStructLiteral, checkStructParent, checkValue } from "./verify/values.js"
import { checkClassField, checkClassFields, checkConstruction, checkImplements, checkStaticMember, checkSuperCall, checkThisReturn } from "./verify/classes.js"
import { calleeName, calleeSignature, checkAsyncCallback, checkBuiltinCall, checkCall, checkCallable, checkCallbackParams, checkCallbackThis, checkForEachReturn, checkParamDefaults, checkSortComparator, checkTimerArgument, unwrapHandledPromise } from "./verify/calls.js"
import { checkExhaustive, checkFunctionEnd, checkSwitchCases, checkUndefinedName, checkUseBeforeDeclaration, returnTarget } from "./verify/control.js"
import { checkBuiltinMember, checkDetachedMethod, hasMember, memberNames } from "./verify/members.js"
import { checkEnumArithmetic, checkEnumFrom, checkEnumMember, checkVariantCalls, checkVariantMember } from "./verify/enums.js"
import { checkAliasCycle, checkDeclaredTypes, checkTypeArgumentCount, checkTypeNames, checkTypedPattern } from "./verify/types.js"
import { checkConstant, checkNotNullish, checkNullable, checkNullableCall, checkNullableConcat, checkUnionMember } from "./verify/nullable.js"
import { checkArithmetic, checkBigIntMix, checkComparison, checkCompound, checkConstantOverflow, checkIncrement, checkNumberLiteral, checkZeroDivisor } from "./verify/operators.js"
import { MUTATING, checkBuiltinWrite, checkDeclaredWrite, checkDelete, checkDeleteElement, checkLockedWrite, checkReadonlyChange, checkRecordWrite } from "./verify/writes.js"
import { checkAlwaysTruthy, checkConditionAssignment, checkDuplicateCases, checkDuplicateKeys, checkIndexRange, checkInstanceofPrimitive, checkIsolatedComponent, checkLineContinuation, checkLoopBound, checkNaNComparison, checkRegExp, checkSelfAssignment, inTestPosition } from "./verify/lint.js"

const traverse = _traverse.default ?? _traverse

export function verify(ast, env, report) {
    traverse(ast, {
        TaggedTemplateExpression(path_) {
            if (path_.node._slimMarkup && path_.node._slimQuasis) checkMarkup(path_.node, path_, env, report)
        },

        CatchClause(path_) {
            const param = path_.node.param
            if (param?._slimCatchType) checkTypeNames(readType(param._slimCatchType), param, path_, env, report)
        },

        VariableDeclarator(path_) {
            const { id, init } = path_.node
            if ((t.isObjectPattern(id) || t.isArrayPattern(id)) && init) {
                checkTypedPattern(path_.node, path_, env, report)
                checkNotNullish(t.isCallExpression(init) && t.isIdentifier(init.callee, { name: "__typed_pattern__" }) ? init.arguments[0] : init, path_, env, report, "can't be destructured")
            }
            if (!t.isIdentifier(id) || !t.isCallExpression(init)) return

            const label = typedVariableLabel(init)
            if (!label) return

            if (mentionsThis(readType(label))) {
                report(id, `the "this" type only works in method signatures and fields — write the type name instead`)
                return
            }
            checkTypeNames(readType(label), id, path_, env, report)
            checkValue(readType(label), init.arguments[0], path_, env, report, `"${id.name}"`)
        },

        UpdateExpression(path_) {
            const { argument } = path_.node
            if (checkLockedWrite(argument, path_, report)) return
            if (checkDeclaredWrite(path_.node, argument, path_, env, report)) return
            if (t.isMemberExpression(argument) && argument.computed) checkReadonlyChange(argument.object, "++/--", path_, env, report)
            if (t.isIdentifier(argument) && checkConstant(path_.node, argument.name, path_.scope.getBinding(argument.name), report)) return
            checkIncrement(path_.node, path_, env, report)
        },

        ObjectExpression(path_) {
            checkDuplicateKeys(path_, report)
        },

        "IfStatement|WhileStatement|DoWhileStatement|ConditionalExpression"(path_) {
            checkConditionAssignment(path_.node.test, report)
            checkAlwaysTruthy(path_.node.test, path_, env, report)
        },

        LogicalExpression(path_) {
            if (path_.node.operator === "??") return
            checkAlwaysTruthy(path_.node.left, path_, env, report, true)
            if (inTestPosition(path_)) checkAlwaysTruthy(path_.node.right, path_, env, report, true)
        },

        UnaryExpression(path_) {
            if (path_.node.operator === "!") checkAlwaysTruthy(path_.node.argument, path_, env, report, true)
            checkDeleteElement(path_.node, path_, env, report)
            if (path_.node.operator !== "delete") return
            if (checkLockedWrite(path_.node.argument, path_, report)) return
            checkDelete(path_.node, path_, env, report)
        },

        BinaryExpression(path_) {
            checkConstantOverflow(path_, report)
            checkInstanceofPrimitive(path_.node, path_, env, report)
            checkNaNComparison(path_.node, report)
            if (!checkEnumArithmetic(path_.node, path_, env, report) && !checkBigIntMix(path_.node, path_, env, report)) {
                checkArithmetic(path_.node, path_, env, report)
                checkNullableConcat(path_.node, path_, env, report)
            }
            checkComparison(path_.node, path_, env, report)
        },

        SwitchStatement(path_) {
            checkSwitchCases(path_.node, path_, env, report)
            checkDuplicateCases(path_.node, report)
        },

        RegExpLiteral(path_) {
            checkRegExp(path_.node.pattern, path_.node.flags, path_.node, report)
        },

        NumericLiteral(path_) {
            checkNumberLiteral(path_.node, report)
        },

        ForStatement(path_) {
            checkLoopBound(path_, report)
            if (path_.node.test) checkConditionAssignment(path_.node.test, report)
        },

        ForOfStatement(path_) {
            checkNotNullish(path_.node.right, path_, env, report, "can't be iterated")
        },

        SpreadElement(path_) {
            if (path_.parentPath.isObjectExpression()) return
            checkNotNullish(path_.node.argument, path_, env, report, "can't be spread")
        },

        NewExpression(path_) {
            checkNewStruct(path_.node, env, report)
            checkConstruction(path_.node, path_, env, report)
            const [pattern, flags] = path_.node.arguments
            if (t.isIdentifier(path_.node.callee, { name: "RegExp" }) && !path_.scope.getBinding("RegExp") && t.isStringLiteral(pattern) &&
                (!flags || t.isStringLiteral(flags))) checkRegExp(pattern.value, flags?.value ?? "", pattern, report)
        },

        AssignmentExpression(path_) {
            const { node } = path_
            if (t.isPattern(node.left)) {
                if (node.operator === "=") checkNotNullish(node.right, path_, env, report, "can't be destructured")
                return
            }
            if (checkLockedWrite(node.left, path_, report)) return
            if (checkDeclaredWrite(node, node.left, path_, env, report)) return
            if (checkBuiltinWrite(node.left, path_, env, report)) return
            checkSelfAssignment(node, report)
            if (node.operator !== "=") {
                if (t.isIdentifier(node.left) && checkConstant(node, node.left.name, path_.scope.getBinding(node.left.name), report)) return
                checkCompound(node, path_, env, report)
                return
            }

            const literalKey = t.isMemberExpression(node.left) && node.left.computed && t.isStringLiteral(node.left.property)
            const target = literalKey ? t.memberExpression(node.left.object, t.identifier(node.left.property.value)) : node.left
            if (literalKey) target.start = node.left.start
            if (t.isMemberExpression(target) && (target.computed || t.isIdentifier(target.property, { name: "length" }))) {
                if (checkReadonlyChange(target.object, "assigning to it", path_, env, report)) return
            }
            if (t.isMemberExpression(target) && !target.computed && t.isIdentifier(target.property) && checkRecordWrite(target, node.right, path_, env, report)) return
            if (t.isMemberExpression(target) && !target.computed && t.isIdentifier(target.property)) {
                const objectType = infer(target.object, path_, env)
                const definition = structFor(objectType, env)
                if (!definition) {
                    checkClassField(target, node.right, objectType, path_, env, report)
                    return
                }

                const owner = definition.label
                const name = target.property.name
                const field = definition.fields.get(name)
                if (!field) {
                    if (!definition.methods.has(name) && !definition.open) report(target.property, `"${owner}" has no field "${name}"${didYouMean(name, memberNames(definition))}`)
                    return
                }
                if (field.readonly) {
                    report(target, `"${owner}.${name}" is readonly`)
                    return
                }

                const expected = field.optional ? unionOf([field.type, UNDEFINED]) : field.type
                checkValue(expected, node.right, path_, env, report, `"${owner}.${name}"`)
                return
            }

            if (!t.isIdentifier(node.left)) return

            const binding = path_.scope.getBinding(node.left.name)
            if (checkConstant(node, node.left.name, binding, report)) return
            const declared = binding ? env.bindings.get(binding) : null
            if (!declared) return

            checkValue(declared, node.right, path_, env, report, `"${node.left.name}"`)
        },

        ExpressionStatement(path_) {
            if (!path_.getFunctionParent()?.node.async) return

            const call = unwrapHandledPromise(path_.node.expression)
            if (!calleeSignature(call, path_, env)?.async) {
                if (!t.isCallExpression(call) || call !== path_.node.expression) return
                const type = infer(call, path_, env)
                if (!type || !atoms(type, env).every(atom => atom.kind === "generic" && atom.name === "Promise")) return
            }

            const name = calleeName(call) ?? sourceText(call.callee) ?? "this call"
            const text = (t.isCallExpression(call) && sourceText(call.callee)) || name
            report(call, `"${name}" is async and nothing awaits it: add await, or write "void ${text}(...)" to run it in the background`)
        },

        CallExpression(path_) {
            const { node } = path_

            checkDeclaredTypes(path_, env, report)
            if (t.isIdentifier(node.callee, { name: "__type_def__" })) checkAliasCycle(node, env, report)
            if (t.isIdentifier(node.callee, { name: "__def_struct__" }) || t.isIdentifier(node.callee, { name: "__def_variants__" })) checkImplements(node, env, report)
            if (t.isIdentifier(node.callee, { name: "__def_struct__" })) {
                checkStructDefaults(node, path_, env, report)
                checkStructParent(node, env, report)
            }
            checkCallable(node, path_, env, report)
            checkEnumFrom(node, env, report)
            checkTimerArgument(node, path_, env, report)
            checkZeroDivisor(node, report)
            const match = matchExpression(node)
            if (match) checkExhaustive(node, match, path_, env, report)

            checkAsyncCallback(node, path_, env, report)
            checkNullableCall(node, path_, env, report)
            if (checkVariantCalls(node, path_, env, report)) return

            checkLineContinuation(node, path_, env, report)
            checkIsolatedComponent(path_, env, report)
            if (checkTypeArgumentCount(node, path_, env, report)) return
            checkSortComparator(node, path_, env, report)
            checkSuperCall(node, path_, env, report)
            const constructed = structLiteralName(node, env)
            const constructedType = constructed && (node._slimTypeArgs?.length ? genericOf(constructed, node._slimTypeArgs.map(readType)) : named(constructed))
            if (constructed && t.isObjectExpression(node.arguments[0])) {
                checkStructLiteral(constructedType, node.arguments[0], path_, env, report)
                return
            }
            if (constructed && node._slimTypeArgs?.length && node.arguments[0]) {
                checkValue(constructedType, node.arguments[0], path_, env, report, `the value of "${constructed}.new"`)
                return
            }

            if (t.isIdentifier(node.callee)) {
                checkCall(signatureFor(node.callee.name, path_, env), node, node.callee.name, path_, env, report)
                return
            }

            const callee = node.callee
            if (!t.isMemberExpression(callee) || callee.computed || !t.isIdentifier(callee.property)) return

            const ownStatic = staticSignature(callee.object, callee.property.name, path_, env)
            if (ownStatic?.signature) {
                checkCall(ownStatic.signature, node, `${ownStatic.name}.${callee.property.name}`, path_, env, report)
                return
            }
            if (MUTATING.has(callee.property.name) && t.isMemberExpression(callee.object) && checkLockedWrite(callee.object, path_, report)) return
            if (MUTATING.has(callee.property.name) && checkReadonlyChange(callee.object, `"${callee.property.name}"`, path_, env, report)) return
            const receiver = infer(callee.object, path_, env)
            const definition = structFor(receiver, env)
            const method = definition?.methods.get(callee.property.name)
            const receiverAtom = receiver && single(receiver, env)
            const ownEnum = !definition && receiverAtom && enumMethod(receiverAtom, callee.property.name, env)
            if (ownEnum) {
                checkCall(ownEnum.signature, node, `${receiverAtom.name}.${callee.property.name}`, path_, env, report, ownEnum.bound)
                return
            }
            const classMethod = !definition && classFor(receiver, env)?.methods.get(callee.property.name)
            const self = new Map([["this", receiverThis(receiverAtom)]])
            const field = (definition ?? classFor(receiver, env))?.fields.get(callee.property.name)
            const fieldCall = field && signatureOfType(field.type, env)
            if (method) checkCall(method, node, `${definition.label}.${callee.property.name}`, path_, env, report, new Map([...(definition.bound ?? []), ...self]))
            else if (classMethod) checkCall(classMethod, node, `${receiverAtom.name}.${callee.property.name}`, path_, env, report, self)
            else if (fieldCall) checkCall(fieldCall, node, `${definition?.label ?? receiverAtom.name}.${callee.property.name}`, path_, env, report, definition?.bound ?? null)
            else if (!definition) checkBuiltinCall(node, path_, env, report)
        },

        Function(path_) {
            checkFunctionEnd(path_, env, report)
            checkCallbackParams(path_, env, report)
            checkParamDefaults(path_, env, report)
            checkCallbackThis(path_, report)
        },

        Class(path_) {
            checkClassFields(path_, env, report)
        },

        ReturnStatement(path_) {
            checkThisReturn(path_, env, report)
            checkForEachReturn(path_, report)
            const fn = path_.getFunctionParent()
            const declared = fn ? env.returns.get(fn.node) : null
            if (!declared) return

            const value = path_.node.argument
            if (t.isCallExpression(value) && t.isIdentifier(value.callee, { name: "__try_return__" })) return
            const expected = returnTarget(fn.node, declared, env)
            if (!value) {
                if (!accepts(expected, UNDEFINED, env)) {
                    report(path_.node, `"${declared.name}" must return ${describe(expected)}, got undefined`)
                }
                return
            }

            const given = fn.node.async ? infer(value, path_, env) : null
            const promised = given ? atoms(given, env) : []
            if (promised.length && promised.every(atom => atom.kind === "generic" && atom.name === "Promise")) {
                const awaited = unionOf(promised.map(atom => atom.args[0] ?? ANY))
                if (!accepts(expected, awaited, env)) report(value, `"${declared.name}" must return ${describe(expected)}, got ${describe(given)}`)
                return
            }
            checkValue(expected, value, path_, env, report, `"${declared.name}"`, "must return")
        },

        MemberExpression(path_) {
            const { node } = path_
            const objectType = infer(node.object, path_, env)
            checkLineContinuation(node, path_, env, report)
            checkNullable(node, path_, env, report, objectType)
            if (checkStaticMember(node, path_, env, report)) return
            if (node.computed) checkIndexRange(node, path_, env, report)
            if (node.computed || !t.isIdentifier(node.property)) return
            if (t.isAssignmentExpression(path_.parent) && path_.parent.left === node) return

            if (checkEnumMember(node, path_, env, report)) return
            if (!objectType || checkBuiltinMember(node, objectType, env, report)) return

            const present = atoms(objectType, env).filter(atom => !isNullish(atom))
            const field = node.property.name
            if (present.length > 0 && present.every(atom => enumVariants(atom, env))) {
                checkVariantMember(node, present, env, report)
                return
            }
            if (present.length > 1) {
                checkUnionMember(node, present, env, report)
                return
            }
            const definition = present.length === 1 ? structFor(present[0], env) ?? classFor(present[0], env) : null
            if (!definition) return

            checkDetachedMethod(node, path_, definition, report)
            if (hasMember(definition, field)) return

            report(node.property, `"${definition.label}" has no field "${field}"${didYouMean(field, memberNames(definition))}`)
        },

        Identifier(path_) {
            checkUndefinedName(path_, env, report)
            checkUseBeforeDeclaration(path_, report)
        }
    })
}
