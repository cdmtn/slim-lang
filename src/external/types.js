import { Type, type } from "./defaults.js";

export const SlimVariableTypes = Object.create(null)

export class Struct {}
export class Component {}
export class Enum {
    constructor(name) {
        this.name = name;
    }
}
export class SlimVariableType {
    constructor(value, expected = null) {
        this.value = value;
        this.kind = type(value)
        this.expected = expected ?? this.kind
    }

    [Symbol.toPrimitive](hint) {
        if (typeof this.value === "function") {
            return this.value.toString();
        }

        return this.value;
    }
}
export class EnumValue {
    constructor(value) {
        this.value = value;
    }
}

export function isSameType(a, b) {
    if (typeof a === "function" && typeof b === "object") return b instanceof a
    if (typeof b === "function" && typeof a === "object") return a instanceof b

    return a === b;
}