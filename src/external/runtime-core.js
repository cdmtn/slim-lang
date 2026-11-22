import { type } from "./runtime/matching.js"
export { __custom_types__ } from "./runtime/registry.js"
export { onError, __handle_async_error__, __handle_sync_error__, log, warn, error, info, debug } from "./runtime/errors.js"
export { describe, test, beforeEach, afterEach, beforeAll, afterAll, assert, assertEqual, deepEqual, assertDeepEqual, assertThrows, assertRejects, mock, spyOn } from "./runtime/tests.js"
export { Type, type, __type_ref__, __type_spec__, __type_spec_all__, __type_label__, __type_matches__ } from "./runtime/matching.js"
export { __def_trait__, __def_struct__, __def_enum__, __def_variants__, __variant_is__, __variant_value__, __uses__ } from "./runtime/definitions.js"
export { __try__, __try_return__, __try_rethrow__, Result, Option, __Option__ } from "./runtime/results.js"
export { __typed_variable__, __typed_catch__, __match_type__, __as_struct__, __typed_return__, __typed_pattern__, __typed_variable_check__, __typed_parameter__, __typed_static_field__, __typed_static_field_check__, __argument_typed__, __type_def__, __typed__ } from "./runtime/typed.js"
export { __sizeof__, __is_empty__, __copyof__, __intdiv__, __match_eq__, __match_rest__ } from "./runtime/operators.js"
export { __lock_object__ } from "./runtime/lock.js"
export { createForm } from "./runtime/forms.js"

export { effect, watch, untrack, batch, onCleanup, resource, provideData, createContext, provide, inject, catchError, touch } from "./reactive.js"
export {
    __signal__, __computed__, __field__, __mut__, __mut_deep__, __is__, __render_effect__, __component__, __defaults__, __live__, __lazy_children__
} from "./reactive.js"
export { Struct, Component } from "./types.js"
export { StructError, StructPassedError, StructExpectError, ArgumentDeclarationTypeError } from "./classErrors.js"

export const __kindof__ = type
