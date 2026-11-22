import { StructPassedError, StructError, StructExpectError, ArgumentDeclarationTypeError } from "./classErrors.js"
import { Struct, Component } from "./types.js"
import { REACTIVE_GLOBALS } from "./reactive.js"
import { __handle_async_error__, __handle_sync_error__, debug, error, info, log, onError, warn } from "./runtime/errors.js"
import { Type, __type_label__, __type_matches__, __type_ref__, __type_spec__, __type_spec_all__, type } from "./runtime/matching.js"
import { __def_enum__, __def_struct__, __def_trait__, __def_variants__, __uses__, __variant_is__, __variant_value__ } from "./runtime/definitions.js"
import { Result, __Option__, __try__, __try_rethrow__, __try_return__ } from "./runtime/results.js"
import { __argument_typed__, __as_struct__, __match_type__, __type_def__, __typed__, __typed_catch__, __typed_parameter__, __typed_pattern__, __typed_return__, __typed_static_field__, __typed_static_field_check__, __typed_variable__, __typed_variable_check__ } from "./runtime/typed.js"
import { __copyof__, __intdiv__, __is_empty__, __match_eq__, __match_rest__, __sizeof__ } from "./runtime/operators.js"
import { __lock_object__ } from "./runtime/lock.js"
import { __kindof__ } from "./runtime-core.js"

export * from "./runtime-core.js"

export const CORE_GLOBALS = {
    log, warn, error, info, debug,

    type,

    Component, Type, Struct,

    onError,

    __kindof__, __def_struct__, __def_enum__, __def_trait__, __uses__, __typed__, __handle_async_error__,
    __handle_sync_error__, __sizeof__, __is_empty__, __lock_object__,
    __typed_variable__, __typed_variable_check__, __typed_pattern__, __typed_return__, __as_struct__,
    __intdiv__, __copyof__, __match_eq__, __match_type__, __match_rest__, __typed_catch__,
    __def_variants__, __variant_is__, __variant_value__, __try__, __try_return__, __try_rethrow__, Result, __Option__,
    __typed_parameter__, __typed_static_field__, __typed_static_field_check__,
    __type_def__, __argument_typed__,
    __type_ref__, __type_spec__, __type_spec_all__, __type_matches__, __type_label__,

    StructError, StructPassedError, StructExpectError, ArgumentDeclarationTypeError,

    ...REACTIVE_GLOBALS
}

Object.assign(globalThis, CORE_GLOBALS)
