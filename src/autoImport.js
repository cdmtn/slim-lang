import fs from "node:fs"
import path from "node:path"
import { builtinModules } from "node:module"
import _traverse from "@babel/traverse"
import * as t from "@babel/types"
import { parseProgram } from "./syntax/index.js"
import { readType } from "./external/typeSyntax.js"
import { KNOWN } from "./checker/core.js"

const traverse = _traverse.default ?? _traverse

const SKIPPED_DIRS = new Set(["node_modules", ".git"])
const exportCache = new Map()

const DOM_GLOBALS = `
window self document location history navigator screen frames opener localStorage sessionStorage indexedDB caches
customElements visualViewport devicePixelRatio innerWidth innerHeight outerWidth outerHeight scrollX scrollY pageXOffset pageYOffset
alert confirm prompt requestAnimationFrame cancelAnimationFrame requestIdleCallback cancelIdleCallback getComputedStyle
getSelection matchMedia scrollTo scrollBy postMessage reportError createImageBitmap trustedTypes speechSynthesis
Window Document DocumentFragment DocumentType Node NodeList NodeIterator NodeFilter TreeWalker Element HTMLElement SVGElement
MathMLElement Attr CharacterData Text Comment CDATASection ProcessingInstruction ShadowRoot HTMLCollection NamedNodeMap
DOMTokenList DOMRect DOMRectReadOnly DOMPoint DOMPointReadOnly DOMMatrix DOMMatrixReadOnly DOMQuad DOMParser DOMImplementation
DOMStringMap DOMStringList XMLSerializer XMLDocument XPathEvaluator XPathResult Range StaticRange AbstractRange Selection
Highlight HighlightRegistry Location History Navigator Screen ScreenOrientation Storage StorageEvent Image Audio Option
HTMLAnchorElement HTMLAreaElement HTMLAudioElement HTMLBRElement HTMLBaseElement HTMLBodyElement HTMLButtonElement
HTMLCanvasElement HTMLDListElement HTMLDataElement HTMLDataListElement HTMLDetailsElement HTMLDialogElement HTMLDivElement
HTMLEmbedElement HTMLFieldSetElement HTMLFormElement HTMLHRElement HTMLHeadElement HTMLHeadingElement HTMLHtmlElement
HTMLIFrameElement HTMLImageElement HTMLInputElement HTMLLIElement HTMLLabelElement HTMLLegendElement HTMLLinkElement
HTMLMapElement HTMLMediaElement HTMLMenuElement HTMLMetaElement HTMLMeterElement HTMLModElement HTMLOListElement
HTMLObjectElement HTMLOptGroupElement HTMLOptionElement HTMLOutputElement HTMLParagraphElement HTMLPictureElement
HTMLPreElement HTMLProgressElement HTMLQuoteElement HTMLScriptElement HTMLSelectElement HTMLSlotElement HTMLSourceElement
HTMLSpanElement HTMLStyleElement HTMLTableCaptionElement HTMLTableCellElement HTMLTableColElement HTMLTableElement
HTMLTableRowElement HTMLTableSectionElement HTMLTemplateElement HTMLTextAreaElement HTMLTimeElement HTMLTitleElement
HTMLTrackElement HTMLUListElement HTMLUnknownElement HTMLVideoElement HTMLFormControlsCollection HTMLOptionsCollection
SVGSVGElement SVGGraphicsElement SVGPathElement SVGGElement CSSStyleSheet CSSStyleDeclaration CSSRule CSSRuleList CSS
StyleSheet StyleSheetList MediaQueryList FontFace FontFaceSet ElementInternals CustomElementRegistry ValidityState
UIEvent MouseEvent KeyboardEvent PointerEvent TouchEvent Touch TouchList WheelEvent FocusEvent InputEvent CompositionEvent
DragEvent DataTransfer DataTransferItem DataTransferItemList ClipboardEvent Clipboard ClipboardItem SubmitEvent
FormDataEvent ErrorEvent PromiseRejectionEvent HashChangeEvent PopStateEvent PageTransitionEvent BeforeUnloadEvent
ProgressEvent AnimationEvent TransitionEvent ToggleEvent SecurityPolicyViolationEvent
FileList FileReader FileSystemHandle FileSystemFileHandle FileSystemDirectoryHandle Notification Permissions PermissionStatus
Geolocation GeolocationPosition MutationObserver MutationRecord ResizeObserver ResizeObserverEntry IntersectionObserver
IntersectionObserverEntry XMLHttpRequest XMLHttpRequestUpload EventSource Worker SharedWorker ServiceWorker
ServiceWorkerContainer ServiceWorkerRegistration Cache CacheStorage IDBFactory IDBDatabase IDBTransaction IDBObjectStore
IDBIndex IDBCursor IDBKeyRange IDBRequest IDBOpenDBRequest Animation KeyframeEffect AnimationTimeline DocumentTimeline
CanvasRenderingContext2D OffscreenCanvas OffscreenCanvasRenderingContext2D ImageData ImageBitmap Path2D CanvasGradient
CanvasPattern TextMetrics WebGLRenderingContext WebGL2RenderingContext AudioContext OfflineAudioContext AudioBuffer
AudioNode GainNode OscillatorNode AnalyserNode MediaStream MediaStreamTrack MediaRecorder MediaSource MediaDevices
MediaError TimeRanges TextTrack VideoFrame RTCPeerConnection RTCSessionDescription RTCIceCandidate RTCDataChannel
SpeechSynthesisUtterance Gamepad VisualViewport Selection IdleDeadline Lock LockManager WakeLock Credential
PasswordCredential PublicKeyCredential CredentialsContainer PaymentRequest Report ReportingObserver TrustedHTML
`.split(/\s+/).filter(Boolean)

const NODE_ONLY = new Set([...builtinModules, "require", "module", "exports", "__filename", "__dirname"])

export const HOST_GLOBALS = new Set([
    ...Object.getOwnPropertyNames(globalThis).filter(name => /^[A-Za-z$][\w$]*$/.test(name) && !NODE_ONLY.has(name)),
    ...DOM_GLOBALS
])

const TAG_NAME = /<([a-z][a-z0-9._]*-[a-z0-9._-]*)(?=[\s/>])/g
const COMPONENT_TAG = /<([A-Z][A-Za-z0-9_$]*)(?=[\s/>])/g
const tagKey = tag => `<${tag}>`

function definedTags(node, out = new Set()) {
    if (!node || typeof node !== "object") return out
    if (Array.isArray(node)) {
        for (const item of node) definedTags(item, out)
        return out
    }
    if (node.type === "CallExpression") {
        const { callee, arguments: args } = node
        const defines = t.isIdentifier(callee, { name: "__define_element__" }) ||
            t.isMemberExpression(callee) && t.isIdentifier(callee.property, { name: "define" }) &&
            (t.isIdentifier(callee.object, { name: "customElements" }) || t.isMemberExpression(callee.object) && t.isIdentifier(callee.object.property, { name: "customElements" }))
        if (defines && t.isStringLiteral(args[0]) && args[0].value.includes("-")) out.add(args[0].value)
    }
    for (const key of Object.keys(node)) {
        if (key === "loc" || key === "start" || key === "end" || key.startsWith("_") || key === "leadingComments" || key === "trailingComments") continue
        const value = node[key]
        if (value && typeof value === "object") definedTags(value, out)
    }
    return out
}

function exportedNames(file) {
    const { mtimeMs, size } = fs.statSync(file)
    const cached = exportCache.get(file)
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.names

    const names = []
    let ast
    try {
        ast = parseProgram(fs.readFileSync(file, "utf8"), file)
    } catch {
        ast = null
    }
    for (const node of ast?.program.body ?? []) {
        if (!t.isExportNamedDeclaration(node)) continue
        if (node.declaration) {
            names.push(...Object.keys(t.getBindingIdentifiers(node.declaration, false, true)))
            continue
        }
        if (node.source) continue
        for (const specifier of node.specifiers) {
            if (t.isExportSpecifier(specifier)) names.push(t.isIdentifier(specifier.exported) ? specifier.exported.name : specifier.exported.value)
        }
    }
    if (ast) for (const tag of definedTags(ast.program.body)) names.push(tagKey(tag))
    exportCache.set(file, { mtimeMs, size, names })
    return names
}

function slimFiles(dir, skip, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRS.has(entry.name) && !skip.has(path.resolve(full))) slimFiles(full, skip, out)
        } else if (entry.name.endsWith(".slim") && !entry.name.endsWith(".test.slim")) {
            out.push(path.resolve(full))
        }
    }
    return out
}

export function projectExports(roots, { skip = [] } = {}) {
    const index = new Map()
    const skipped = new Set(skip.map(dir => path.resolve(dir)))
    for (const root of [roots].flat()) {
        for (const file of slimFiles(path.resolve(root), skipped)) {
            for (const name of exportedNames(file)) {
                if (!index.has(name)) index.set(name, file)
                else if (index.get(name) !== file) index.set(name, null)
            }
        }
    }
    return index
}

export function exportsFingerprint(index) {
    return [...index].map(([name, file]) => `${name}:${file ?? "?"}`).sort().join("\n")
}

function specifierFor(fromFile, target) {
    const relative = path.relative(path.dirname(fromFile), target).replace(/\\/g, "/").replace(/\.slim$/, "")
    return relative.startsWith("./") || relative.startsWith("../") ? relative : "./" + relative
}

const TYPE_ARGUMENTS = {
    __typed_variable__: [1],
    __typed_pattern__: [1],
    __typed_parameter__: [1],
    __declare_return__: [0],
    __typed_catch__: [1],
    __match_type__: [1],
    __as_struct__: [1],
    __def_struct__: [1],
    __def_trait__: [1],
    __def_variants__: [1],
    __type_def__: [1, 2]
}

const TYPE_PARAMETERS = {
    __def_struct__: 6,
    __def_variants__: 2,
    __def_trait__: 4
}

function stringsIn(node, out = []) {
    if (!node || typeof node !== "object") return out
    if (t.isStringLiteral(node)) out.push(node.value)
    else if (t.isArrayExpression(node)) node.elements.forEach(element => stringsIn(element, out))
    else if (t.isObjectExpression(node)) node.properties.forEach(property => t.isObjectProperty(property) && stringsIn(property.value, out))
    return out
}

function typeNames(type, out = new Set()) {
    if (!type || typeof type !== "object") return out
    if (Array.isArray(type)) {
        type.forEach(item => typeNames(item, out))
        return out
    }
    if ((type.kind === "named" || type.kind === "generic" || type.kind === "enumMember") && typeof type.name === "string") out.add(type.name)
    for (const value of Object.values(type)) if (value && typeof value === "object") typeNames(value, out)
    return out
}

export function autoImportsFor(ast, sourceFile, index, taken = new Set(), { code = null, warnings = null } = {}) {
    const own = path.resolve(sourceFile)
    const byFile = new Map()
    const tagFiles = new Set()
    const shadowed = new Map()
    const note = (path_, name) => {
        if (taken.has(name) || path_.scope.getBinding(name)) return
        const file = index.get(name)
        if (!file || file === own) return
        if (HOST_GLOBALS.has(name)) {
            if (!shadowed.has(name)) shadowed.set(name, { file, loc: path_.node.loc })
            return
        }
        if (!byFile.has(file)) byFile.set(file, new Set())
        byFile.get(file).add(name)
    }
    const noteTag = tag => {
        const file = index.get(tagKey(tag))
        if (file && file !== own) tagFiles.add(file)
    }
    const noteTypeName = (path_, name, own = null) => {
        if (!KNOWN.has(name) && !own?.has(name)) note(path_, name)
    }
    const noteType = (path_, label) => {
        if (typeof label !== "string") return
        for (const name of typeNames(readType(label))) noteTypeName(path_, name)
    }
    traverse(ast, {
        ReferencedIdentifier(path_) {
            if (path_.parentPath.isUnaryExpression({ operator: "typeof" }) && path_.parent.argument === path_.node) return
            note(path_, path_.node.name)
        },
        TaggedTemplateExpression(path_) {
            if (!t.isIdentifier(path_.node.tag, { name: "__html__" })) return
            for (const quasi of path_.node.quasi.quasis) {
                for (const [, tag] of (quasi.value.raw ?? "").matchAll(TAG_NAME)) noteTag(tag)
                for (const [, name] of (quasi.value.raw ?? "").matchAll(COMPONENT_TAG)) note(path_, name)
            }
        },
        CallExpression(path_) {
            const { callee, arguments: args } = path_.node
            if (t.isMemberExpression(callee) && t.isIdentifier(callee.property, { name: "createElement" }) && t.isStringLiteral(args[0])) noteTag(args[0].value)
            if (!t.isIdentifier(callee)) return
            const slots = TYPE_ARGUMENTS[callee.name]
            if (!slots) return
            const own = new Set(TYPE_PARAMETERS[callee.name] === undefined ? [] : stringsIn(args[TYPE_PARAMETERS[callee.name]]))
            for (const slot of slots) {
                for (const label of stringsIn(args[slot])) {
                    for (const name of typeNames(readType(label))) noteTypeName(path_, name, own)
                }
            }
        },
        VariableDeclarator(path_) {
            noteType(path_, path_.node._slimType)
            const props = path_.node.init?._slimComponentProps
            noteType(path_, props?.type)
            for (const field of props?.fields ?? []) noteType(path_, field.type)
        },
        "ClassProperty|ClassPrivateProperty"(path_) {
            noteType(path_, path_.node._slimField?.type)
        },
        Function(path_) {
            const signature = path_.node._slimSignature
            if (!signature) return
            const own = new Set(signature.typeParams ?? [])
            for (const label of [...(signature.params ?? []), signature.returns]) {
                if (typeof label !== "string") continue
                for (const name of typeNames(readType(label))) noteTypeName(path_, name, own)
            }
        },
        NewExpression(path_) {
            for (const label of path_.node._slimTypeArgs ?? []) noteType(path_, label)
        },
        AssignmentExpression(path_) {
            if (t.isIdentifier(path_.node.left)) note(path_, path_.node.left.name)
        },
        UpdateExpression(path_) {
            if (t.isIdentifier(path_.node.argument)) note(path_, path_.node.argument.name)
        }
    })
    if (warnings) {
        const lines = code === null ? [] : code.split(/\r?\n/)
        for (const [name, { file, loc }] of shadowed) {
            const raw = specifierFor(own, file)
            const line = loc?.start.line ?? 1
            warnings.push({
                message: `"${name}" is a browser global, so it is not auto-imported from "${raw}"; write use { ${name} } from "${raw}" for the project's one`,
                severity: "warning",
                sourceFile,
                line,
                column: (loc?.start.column ?? 0) + 1,
                sourceLine: lines[line - 1] ?? ""
            })
        }
    }
    const found = [...byFile].map(([file, names]) => ({ file, raw: specifierFor(own, file), names: [...names].sort() }))
    for (const file of tagFiles) {
        if (!byFile.has(file)) found.push({ file, raw: specifierFor(own, file), names: [], sideEffect: true })
    }
    return found
}
