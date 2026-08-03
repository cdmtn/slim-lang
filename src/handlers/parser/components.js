import { idify } from "../../external/helpers.js";

function parseComponents(code) {
    let out = "";
    let i = 0;

    while (i < code.length) {
        const match = code.slice(i).match(/\b(?:(isolated)\s+)?component\b/);

        if (!match) {
            out += code.slice(i);
            break;
        }

        const isolated = !!match[1];
        const start = i + match.index;

        out += code.slice(i, start);

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

        out += buildComponent(name, args, body, isolated);

        i = p;
    }

    return out;
}

function buildComponent(name, args, body, isolated = false) {
    const match = body.match(/return\s*\(?\s*([\s\S]*?)\s*\)?\s*$/);

    if (!match) {
        throw new Error(`Component "${name}" must contain return`);
    }

    const html = match[1]
        .trim()
        .replace(/`/g, "\\`");

    const encodedName = `${name}_Component`

    if(!isolated) {
        return `
        const ${name} = (args = {}) => { 
            let { ${args} } = args;
            ${body.split("return")[0].trim()}; 
            return \`${html}\`; 
        };
        ${name}.__component__ = true
        `;
    }
    else {
        const argsSplitted = args.split(",").map(item => `"${item.trim()}"`)

        return `
        const ${name} = (args = {}) => { 
            let { ${args} } = args;
            return new Function(${argsSplitted}, "${body.split("return")[0].trim()}; return \`${html}\`;")(${args}) 
        };
        ${name}.__component__ = true
        `;
    }
}

export {
    parseComponents,
    buildComponent
}