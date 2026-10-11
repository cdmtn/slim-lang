// Public diagnostic identifiers. Never renumber these when adding a diagnostic.
export const ERROR_CODES = Object.freeze({
    TYPE: "S0001",
    MISSING_FIELD: "S0002",
    UNKNOWN_FIELD: "S0003",
    JSON: "S0004",
    ARGUMENT_COUNT: "S0005",
    MATCH: "S0006",
    DECLARATION: "S0007",
    RUNTIME: "S0008",
    SYNTAX: "S0009"
})

export const VALID_ERROR_CODES = new Set(Object.values(ERROR_CODES))
