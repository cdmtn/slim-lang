function parseComponentsEdits(code) {
    const edits = [];
    let i = 0;

    while (i < code.length) {
        const match = code.slice(i).match(/\b(?:(isolated)\s+)?component\b/);

        if (!match) break;

        const isolated = !!match[1];
        const start = i + match.index;

        let p = start + match[0].length;

        while (/\s/.test(code[p])) p++;

        // name
        const nameStart = p;
        while (/[a-zA-Z0-9_$]/.test(code[p])) p++;
        const name = code.slice(nameStart, p);

        while (/\s/.test(code[p])) p++;

        // args
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

        // body
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

        edits.push({ start, end: p, replacement: buildComponent(name, args, body, isolated) });

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

function componentBinding(name, args) {
    const trimmed = args.trim();

    if (!trimmed) return "";
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
    if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return trimmed;

    throw new Error(
        `Component "${name}" arguments must be a single object name (e.g. "props") or a destructuring pattern (e.g. "{ content }"), got: "${trimmed}"`
    );
}

function buildComponent(name, args, body, isolated = false) {
    const match = body.match(/return\s*\(?\s*([\s\S]*?)\s*\)?\s*$/);

    if (!match) {
        throw new Error(`Component "${name}" must contain return`);
    }

    const html = match[1]
        .trim()
        .replace(/`/g, "\\`");

    const before = body.split("return")[0].trim();
    const binding = componentBinding(name, args);
    const param = binding ? `${binding} = {}` : "";

    if(!isolated) {
        return `
        const ${name} = (${param}) => {
        	const s = {};
            ${before};
            return htmlToVdom(__html__\`${html}\`).toElement();
        };
        ${name}.__component__ = true
        `;
    }
    else {
        const fnBody = `${before}; return htmlToVdom(__html__\`${html}\`).toElement();`;

        return `
        const ${name} = (__props__ = {}) => {
            return new Function(${JSON.stringify(binding)}, ${JSON.stringify(fnBody)})(__props__);
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