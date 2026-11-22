import {
    test, describe, assert, assertEqual, assertDeepEqual, assertThrows, assertRejects,
    beforeEach, afterEach, beforeAll, afterAll, mock, spyOn
} from "./runtime-core.js"

export const TEST_GLOBALS = {
    test, describe, assert, assertEqual, assertDeepEqual, assertThrows, assertRejects,
    beforeEach, afterEach, beforeAll, afterAll, mock, spyOn
}

Object.assign(globalThis, TEST_GLOBALS)
