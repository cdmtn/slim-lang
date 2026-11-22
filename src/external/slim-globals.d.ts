declare function log(...args: any[]): void
declare function warn(...args: any[]): void
declare function error(...args: any[]): void
declare function info(...args: any[]): void
declare function debug(...args: any[]): void

declare function type(value: any): string

declare function onError(handler: (error: any) => void): void
interface SlimTestOptions { timeout?: number }
interface SlimTest {
    (name: string, fn: () => void | Promise<void>, options?: SlimTestOptions): void
    skip(name: string, fn?: () => void | Promise<void>, options?: SlimTestOptions): void
    only(name: string, fn: () => void | Promise<void>, options?: SlimTestOptions): void
}
interface SlimDescribe {
    (name: string, fn: () => void): void
    skip(name: string, fn: () => void): void
    only(name: string, fn: () => void): void
}
interface SlimMock<F extends (...args: any[]) => any = (...args: any[]) => any> {
    (...args: Parameters<F>): ReturnType<F>
    calls: Parameters<F>[]
    callCount: number
    returnValue: ReturnType<F> | undefined
    returns(value: ReturnType<F>): SlimMock<F>
    returnsOnce(value: ReturnType<F>): SlimMock<F>
    implement(fn: F): SlimMock<F>
    calledWith(...args: Parameters<F>): boolean
    lastCall(): Parameters<F> | undefined
    reset(): SlimMock<F>
}
interface SlimSpy<F extends (...args: any[]) => any> extends SlimMock<F> { restore(): SlimSpy<F> }
declare const test: SlimTest
declare const describe: SlimDescribe
declare function beforeEach(fn: () => void | Promise<void>): void
declare function afterEach(fn: () => void | Promise<void>): void
declare function beforeAll(fn: () => void | Promise<void>): void
declare function afterAll(fn: () => void | Promise<void>): void
declare function assert(condition: any, message?: string): void
declare function assertEqual(actual: any, expected: any, message?: string): void
declare function assertDeepEqual(actual: any, expected: any, message?: string): void
declare function assertThrows(fn: () => any, expected?: string | RegExp | (new (...args: any[]) => any), message?: string): any
declare function assertRejects(fn: (() => Promise<any>) | Promise<any>, expected?: string | RegExp | (new (...args: any[]) => any), message?: string): Promise<any>
declare function mock<F extends (...args: any[]) => any = (...args: any[]) => any>(implementation?: F): SlimMock<F>
declare function spyOn<T, K extends keyof T>(object: T, method: K): T[K] extends (...args: any[]) => any ? SlimSpy<T[K]> : never


type SlimVariantMethods<T> = { unwrap(): T; unwrapOr<D>(fallback: D): T | D }
type Result<T, E> = ({ readonly $tag: "Ok", value: T } | { readonly $tag: "Err", error: E }) & SlimVariantMethods<T> & {
    isOk(): boolean; isErr(): boolean; map<U>(fn: (value: T) => U): Result<U, E>; mapErr<F>(fn: (error: E) => F): Result<T, F>
}
type Option<T> = ({ readonly $tag: "Some", value: T } | { readonly $tag: "None" }) & SlimVariantMethods<T> & {
    isSome(): boolean; isNone(): boolean; map<U>(fn: (value: T) => U): Option<U>
}
declare const Result: {
    Ok<T>(value: T): Result<T, any>; Err<E>(error: E): Result<any, E>
    attempt<T>(fn: () => T): T extends Promise<infer U> ? Promise<Result<U, any>> : Result<T, any>
    fromPromise<T>(promise: Promise<T>): Promise<Result<T, any>>
    fromJSON(data: any): Result<any, any>
}
declare const __Option__: { Some<T>(value: T): Option<T>; None: Option<any>; from<T>(value: T | null | undefined): Option<T>; fromJSON(data: any): Option<any> }

declare function effect(fn: () => void | (() => void)): () => void
declare function watch<T>(source: () => T, fn: (value: T, previous: T | undefined) => void | (() => void)): () => void
declare function untrack<T>(fn: () => T): T
declare function touch<T>(object: T): T
declare function batch<T>(fn: () => T): T
declare function onCleanup(fn: () => void): void
declare function onRemove(node: Node, fn: (node: Node) => void): () => void
declare function listen(target: EventTarget, event: string, fn: (event: any) => void, options?: boolean | AddEventListenerOptions): () => void
declare function render(view: any, target: Element): () => void
declare function upgrade<T>(root: T): T
declare function dispose(node: Node): void
declare function setHtml<T>(el: T, markup: any): T
declare function resource<T>(loader: () => T | Promise<T>, initial?: T): { value: T | undefined, readonly loading: boolean, readonly error: any, reload(): void }
declare namespace resource {
    function pages<T>(...args: any[]): { readonly items: T[], readonly pages: any[], readonly loading: boolean, readonly error: any, readonly done: boolean, reload(): void, more(): Promise<boolean> }
}
declare function provideData<T>(key: string, compute: T | (() => T)): T
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

declare function __def_struct__(name: string, schema: any, specifications?: any, defaults?: any, extendsName?: any, methods?: any, typeParams?: string[] | null, readonly?: string[] | null, traits?: string[] | null): any
declare function __def_enum__(name: string, schema: any): any
declare function __def_variants__(name: string, variants: any, typeParams?: string[] | null, methods?: any, traits?: string[] | null, release?: boolean): any
declare function __def_trait__(name: string, schema: any, required?: any, defaults?: any, typeParams?: string[] | null): any
declare function __variant_is__(value: any, variant: any): boolean
declare function __variant_value__(value: any, variant: any, index: number): any
declare function __try__(value: any): any
declare function __try_return__(error: any): any
declare function __try_rethrow__(error: any): void
declare function __typed_catch__(error: any, specification: any): void
declare function __typed_return__<T>(value: T, specification?: any, fnName?: string): T
declare function __match_rest__(subject: any, taken: string[]): any
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

declare function __kindof__(value: any): string
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
declare function __signal__<T>(value: T, equals?: (previous: T, next: T) => boolean): { v: T, notify(): void }
declare function __computed__<T>(fn: () => T): { readonly v: T }
declare function __field__<T>(fn: () => T): { readonly v: T }
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
declare function raw(html: string | any[], options?: { fresh?: boolean }): any
declare namespace raw {
    function join(list: any[], separator?: any): any
}
declare function escapeHtml(value: any): string

declare class StructError extends Error {}
declare class StructPassedError extends Error {}
declare class StructExpectError extends Error {}
declare class ArgumentDeclarationTypeError extends Error {}
