import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

const INTERNALS = [
    "tt", "tokenIsIdentifier", "tokenIsKeywordOrIdentifier", "tokenCanStartExpression",
    "tokenOperatorPrecedence", "ExpressionErrors", "functionFlags"
]
const PLUGIN_TABLES = ["mixinPlugins", "mixinPluginNames", "parserClassCache"]

const EXTRA_EXPORTS = `
exports.internals = { ${INTERNALS.join(", ")} };
exports.registerPlugin = function registerPlugin(name, mixin) {
  if (!Object.prototype.hasOwnProperty.call(mixinPlugins, name)) mixinPluginNames.push(name);
  mixinPlugins[name] = mixin;
  parserClassCache.clear();
};
`

function declares(source, name) {
    return new RegExp(`^(?:const|let|var|function|class) ${name}\\b`, "m").test(source)
}

function loadParser() {
    const file = require.resolve("@babel/parser")
    const { version } = require("@babel/parser/package.json")
    const source = fs.readFileSync(file, "utf8")

    const missing = [...INTERNALS, ...PLUGIN_TABLES].filter(name => !declares(source, name))
    if (missing.length > 0) {
        throw new Error(`Slim can't hook into @babel/parser ${version} (no ${missing.join(", ")}): ` +
            `install the version pinned in Slim's package.json`)
    }

    const run = vm.compileFunction(source + EXTRA_EXPORTS, ["exports", "require", "module", "__filename", "__dirname"], {
        filename: file
    })
    const module = { exports: {} }
    run(module.exports, createRequire(file), module, file, path.dirname(file))
    return module.exports
}

export const babel = loadParser()
