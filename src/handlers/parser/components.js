import fs from "node:fs"
import path from "node:path"
import { tokenize } from "../../lexer.js"
import { parseTypedArgs, buildTypedArgsResult } from "../parserHandler.js"

let bemCache = null
function useBEMClasses() {
    if (bemCache !== null) return bemCache
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "slimconfig.json"), "utf8"))
        bemCache = !!(cfg.components && cfg.components.useBEMClasses === true)
    } catch {
        bemCache = false
    }
    return bemCache
}

function kebabCase(name) {
    return name
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replace(/[_\s]+/g, "-")
        .toLowerCase()
}

function elementExpr(html, name) {
    if (!useBEMClasses()) return `htmlToVdom(__html__\`${html}\`).toElement()`
    return `(() => { const __v__ = htmlToVdom(__html__\`${html}\`); __resolve_bem__(__v__, ${JSON.stringify(kebabCase(name))}); return __v__.toElement(); })()`
}

const OPENERS = new Set(["(", "[", "{", "${"])
const CLOSERS = new Set([")", "]", "}"])

function templateReturnStart(body) {
    let depth = 0
    for (const t of tokenize(body)) {
        if (t.type === "punct") {
            if (OPENERS.has(t.value)) depth++
            else if (CLOSERS.has(t.value)) depth--
        } else if (depth === 0 && t.type === "name" && t.keyword && t.value === "return") {
            return t.start
        }
    }
    return -1
}

function literalRanges(code) {
    const tokens = tokenize(code);
    const literal = t => t.type === "string" || t.type === "template" || t.type === "comment" || t.type === "regex";

    return offset => {
        let lo = 0, hi = tokens.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const t = tokens[mid];
            if (offset < t.start) hi = mid - 1;
            else if (offset >= t.end) lo = mid + 1;
            else return literal(t);
        }
        return false;
    };
}

function parseComponentsEdits(code) {
    const edits = [];
    const inLiteral = literalRanges(code);
    let i = 0;

    while (i < code.length) {
        const match = code.slice(i).match(
            /\b(?:(isolated|element)(?:\s*\(\s*["']([^"']+)["']\s*\))?\s+)?component\b/
        );

        if (!match) break;

        const modifier = match[1] ?? null;
        const tag = match[2] ?? null;
        const start = i + match.index;

        if (inLiteral(start + match[0].length - "component".length)) {
            i = start + match[0].length;
            continue;
        }

        let p = start + match[0].length;

        while (/\s/.test(code[p])) p++;

        const nameStart = p;
        while (/[a-zA-Z0-9_$]/.test(code[p])) p++;
        const name = code.slice(nameStart, p);

        while (/\s/.test(code[p])) p++;

        if (code[p] !== "(")
            throw new Error(`Expected "(" after component ${name}`);

        let depth = 1;
        const argsStart = ++p;

        while (depth) {
            if (code[p] === "(") depth++;
            else if (code[p] === ")") depth--;
            p++;
        }

        const args = code.slice(argsStart, p - 1).trim();

        while (/\s/.test(code[p])) p++;

        if (code[p] !== "{")
            throw new Error(`Expected "{" after component ${name}`);

        depth = 1;
        const bodyStart = ++p;

        while (depth) {
            if (code[p] === "{") depth++;
            else if (code[p] === "}") depth--;
            p++;
        }

        const body = code.slice(bodyStart, p - 1);

        edits.push({ start, end: p, replacement: buildComponent(name, args, body, modifier, tag) });

        i = p;
    }

    return edits;
}

function parseComponents(code) {
    const edits = parseComponentsEdits(code);
    let out = "";
    let cursor = 0;
    for (const { start, end, replacement } of edits) {
        out += code.slice(cursor, start) + replacement;
        cursor = end;
    }
    return out + code.slice(cursor);
}

function parseComponentArgs(name, args) {
    const trimmed = args.trim();

    if (!trimmed) return { binding: "", checks: "" };

    let parsed, binding;

    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        parsed = parseTypedArgs(trimmed.slice(1, -1));
        const fields = parsed.map(a => a.default !== null ? `${a.name} = ${a.default}` : a.name);
        binding = `{ ${fields.join(", ")} }`;
    } else {
        parsed = parseTypedArgs(trimmed);

        if (parsed.length !== 1 || !/^[A-Za-z_$][\w$]*$/.test(parsed[0].name)) {
            throw new Error(
                `Component "${name}" arguments must be a single object name (e.g. "props" or "props: SomeStruct") or a destructuring pattern (e.g. "{ id: int }"), got: "${trimmed}"`
            );
        }

        binding = parsed[0].name;
    }

    const { checks } = buildTypedArgsResult(parsed, name);
    return { binding, checks };
}

function escapeTemplateBackticks(s) {
    const n = s.length;
    let out = "";
    let i = 0;
    let depth = 0;
    while (i < n) {
        const c = s[i];
        if (c === "\\") { out += c + (s[i + 1] ?? ""); i += 2; continue; }
        if (depth === 0) {
            if (c === "`") { out += "\\`"; i++; continue; }
            if (c === "$" && s[i + 1] === "{") { out += "${"; i += 2; depth = 1; continue; }
            out += c; i++; continue;
        }
        if (c === "'" || c === "\"" || c === "`") {
            const q = c;
            out += c; i++;
            while (i < n) {
                if (s[i] === "\\") { out += s[i] + (s[i + 1] ?? ""); i += 2; continue; }
                out += s[i];
                if (s[i] === q) { i++; break; }
                i++;
            }
            continue;
        }
        if (c === "{") depth++;
        else if (c === "}") depth--;
        out += c; i++;
    }
    return out;
}

// Explicit tags need a hyphen; implicit tags use the slim- kebab-case prefix.
function elementTag(name, explicit) {
    if (explicit) {
        if (!explicit.includes("-")) {
            throw new Error(
                `Component "${name}": a custom element tag must contain a hyphen, got "${explicit}"`
            );
        }
        return explicit;
    }

    const kebab = name
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replace(/[_\s]+/g, "-")
        .toLowerCase();

    return `slim-${kebab}`;
}

function buildElementComponent(name, binding, before, html, explicitTag, checks = "") {
    const tag = elementTag(name, explicitTag);
    const param = binding ? `${binding} = {}` : "__unused__ = {}";
    const checkPrelude = checks ? `${checks};\n` : "";
    const quoted = JSON.stringify(tag);

    return `
        const ${name} = (__props__ = {}) => ${name}.__render__(__props__);
        ${name}.__component__ = true
        ${name}.tag = ${quoted}
        ${name}.__render__ = (${param}, __host__ = null) => {
        	const s = {};
        	const __mounts__ = [];
        	const __connects__ = [];
        	const __unmounts__ = [];
        	const onMount = (fn) => __mounts__.push(fn);
        	const onConnect = (fn) => __connects__.push(fn);
        	const onUnmount = (fn) => __unmounts__.push(fn);
            ${checkPrelude}${before};
            const __el__ = ${elementExpr(html, name)};

            if (!__host__) {
                for (const fn of __mounts__) fn(__el__);
                __lifecycle__(__el__, __connects__, __unmounts__);
                return __el__;
            }

            __adopt_into__(__host__, __el__);
            for (const fn of __mounts__) fn(__host__);
            return { connects: __connects__, unmounts: __unmounts__ };
        };
        __define_element__(${quoted}, ${name}.__render__)
        `;
}

function buildComponent(name, args, body, modifier = null, tag = null) {
    const returnStart = templateReturnStart(body);

    if (returnStart === -1) {
        throw new Error(`Component "${name}" must contain return`);
    }

    const before = body.slice(0, returnStart).trim();

    let template = body.slice(returnStart + "return".length).trim();
    if (template.startsWith("(") && template.endsWith(")")) {
        template = template.slice(1, -1).trim();
    }
    const html = escapeTemplateBackticks(template);
    const { binding, checks } = parseComponentArgs(name, args);
    const param = binding ? `${binding} = {}` : "";
    const checkPrelude = checks ? `${checks};\n` : "";

    if (modifier === "element") {
        return buildElementComponent(name, binding, before, html, tag, checks);
    }

    const isolated = modifier === "isolated";

    if(!isolated) {
        return `
        const ${name} = (${param}) => {
        	const s = {};
        	const __mounts__ = [];
        	const __connects__ = [];
        	const __unmounts__ = [];
        	const onMount = (fn) => __mounts__.push(fn);
        	const onConnect = (fn) => __connects__.push(fn);
        	const onUnmount = (fn) => __unmounts__.push(fn);
            ${checkPrelude}${before};
            const __el__ = ${elementExpr(html, name)};
            for (const fn of __mounts__) fn(__el__);
            __lifecycle__(__el__, __connects__, __unmounts__);
            return __el__;
        };
        ${name}.__component__ = true
        `;
    }
    else {
        const fnBody = `const __mounts__=[];const __connects__=[];const __unmounts__=[];const onMount=(fn)=>__mounts__.push(fn);const onConnect=(fn)=>__connects__.push(fn);const onUnmount=(fn)=>__unmounts__.push(fn);${before}; const __el__ = ${elementExpr(html, name)}; for (const fn of __mounts__) fn(__el__); __lifecycle__(__el__, __connects__, __unmounts__); return __el__;`;

        const guard = checks ? `const ${binding} = __props__;\n${checks};\n` : "";

        return `
        const ${name} = (__props__ = {}) => {
            ${guard}return new Function(${JSON.stringify(binding)}, ${JSON.stringify(fnBody)})(__props__);
        };
        ${name}.__component__ = true
        `;
    }
}

export {
    parseComponents,
    parseComponentsEdits,
    buildComponent
}
