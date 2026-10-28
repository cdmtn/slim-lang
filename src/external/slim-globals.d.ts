// Runtime globals injected into compiled Slim output.

declare function log(...args: any[]): void
declare function warn(...args: any[]): void
declare function error(...args: any[]): void
declare function info(...args: any[]): void
declare function debug(...args: any[]): void

declare function type(value: any): string

type email = string
type url = string
type uuid = string
type positive = number
type negative = number
type natural = number
type nonempty = string | any[]
declare function onError(handler: (error: any) => void): void
declare function test(name: string, fn: () => void | Promise<void>): void
declare function describe(name: string, fn: () => void): void
declare function assert(condition: any, message?: string): void
declare function assertEqual(actual: any, expected: any, message?: string): void

declare const PI: number

declare function effect(fn: () => void | (() => void)): () => void
declare function watch<T>(source: () => T, fn: (value: T, previous: T | undefined) => void | (() => void)): () => void
declare function untrack<T>(fn: () => T): T
declare function batch<T>(fn: () => T): T
declare function onCleanup(fn: () => void): void
declare function resource<T>(loader: () => T | Promise<T>, initial?: T): { value: T | undefined, readonly loading: boolean, readonly error: any, reload(): void }
declare function renderToString(render: () => any): string
declare function createContext<T>(fallback?: T): { fallback: T | undefined }
declare function provide<T>(context: { fallback: T | undefined }, value: T): void
declare function inject<T>(context: { fallback: T | undefined }): T
declare function catchError(render: () => any, fallback: (error: any, reset: () => void) => any): () => any
declare function hydrate<T>(render: () => T, container: any): T

declare class Struct {}
declare class Component {}
declare class Type {}
declare class HTMLElement {}

declare function __def_struct__(name: string, schema: any, specifications?: any, defaults?: any, extendsName?: any, methods?: any, typeParams?: string[] | null, readonly?: string[] | null): any
declare function __def_enum__(name: string, schema: any): any
declare function __typed__(value: any, structName: any, returnMethod?: string, typeArgs?: string[] | null): any

declare function __typed_variable__<T>(value: T, specification?: any, bindingId?: any, varName?: any): T
declare function __typed_variable_check__<T>(bindingId: any, value: T, varName?: any): T
declare function __typed_pattern__<T>(value: T, typeLabel: any): T
declare function __as_struct__<T>(value: T, typeLabel: string): T
declare function __typed_parameter__(value: any, specification: any, bindingId: any, varName?: any, optional?: any, message?: any): any
declare function __typed_static_field__<T>(owner: any, field: any, value: T, specification?: any, displayName?: any): T
declare function __typed_static_field_check__<T>(owner: any, field: any, value: T, displayName?: any): T

declare function __type_def__(name: string, definition: any, properties?: any): any
declare function __type_ref__(label: string, resolve?: any): any
declare function __type_spec__(...references: any[]): any
declare function __type_spec_all__(...references: any[]): any
declare function __type_matches__(specification: any, value: any): boolean
declare function __type_label__(specification: any): string
declare function __argument_typed__(value: any, expectedType: any): boolean

declare function __sizeof__(value: any): number
declare function __is_empty__(value: any): boolean
declare function __copyof__(value: any): any
declare function __intdiv__(a: number, b: number): number
declare function __match_eq__(subject: any, pattern: any): boolean
declare function __match_type__(subject: any, typeLabel: string): boolean
declare function __lock_object__<T>(value: T): T

declare function __handle_sync_error__(error: any): void
declare function __handle_async_error__(error: any): void
declare function __html__(...args: any[]): any
declare function __component__<T>(fn: () => T): T
declare function __signal__<T>(value: T): { v: T, notify(): void }
declare function __computed__<T>(fn: () => T): { readonly v: T }
declare function __mut__<T>(source: any, result: T): T
declare function __mut_deep__<T>(source: any, change: (object: any) => T, object: any): T
declare function __is__(source: any, key: any, strict: boolean): boolean
declare function __defaults__(props: any, defaults: any): any
declare function __template__(roots: any[], svg?: boolean): () => any
declare function __root__(fn: () => any): any
declare function __insert__(anchor: any, fn: () => any): void
declare function __branch__(test: () => any, yes: () => any, no: (() => any) | null): () => any
declare function __attr__(el: any, name: string, fn: () => any): void
declare function __spread__(el: any, fn: () => any): void
declare function __on__(el: any, event: string, handler: any): void
declare function __list__(anchor: any, source: () => any, render: (item: any, index: any) => any, key?: (item: any, index: number) => any): void
declare function __s__(value: any): string
declare function __once__(anchor: any, value: any): void
declare function __set__(el: any, name: string, value: any): void
declare function __enter__(el: any, className: string): void
declare function __leave__(el: any, className: string): void
declare function __live__(read: () => any): any
declare function __flush_events__(...args: any[]): any
declare function htmlToVdom(...args: any[]): any
declare function raw(html: string): any
declare function escapeHtml(value: any): string

declare class StructError extends Error {}
declare class StructPassedError extends Error {}
declare class StructExpectError extends Error {}
declare class ArgumentDeclarationTypeError extends Error {}
