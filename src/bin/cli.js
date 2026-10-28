#!/usr/bin/env node

import { Command } from "commander";
import { spawnSync } from "node:child_process";
import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

import { log, error, parseValue } from "./helpers.js"
import { runTests } from "../test-runner.js"
import { formatFile } from "../format.js"
import { readJson } from "../modulePaths.js"

import pkg from "../../package.json" with { type: "json" };
import defaultConfig from "./config.default.json" with { type: "json" };

const root = process.cwd()

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const compileScript = path.join(packageRoot, "src", "compile.js")
const runScript = path.join(packageRoot, "run-slim.js")
const devScript = path.join(packageRoot, "run-dev-slim.js")

const program = new Command();
const slimConfigPath = path.join(root, "slimconfig.json")
const packagePath = path.join(root, "package.json")

function runScripts(...scripts) {
    for (const [script, ...args] of scripts) {
        const { status, signal } = spawnSync(process.execPath, [script, ...args], { stdio: "inherit" })
        if (status !== 0) {
            process.exitCode = status ?? (signal ? 1 : 0)
            return false
        }
    }
    return true
}

const splitList = value => value.split(/\s+/).map(item => item.trim()).filter(Boolean)

function writeSlimConfig(config) {
    fs.writeFileSync(slimConfigPath, JSON.stringify(config, null, 4), "utf8")
}

function slimConfigCheck() {
    packageCheck()

    if (!fs.existsSync(slimConfigPath)) {
        error(`The configuration file does not exist, or it is not in the root directory. You can create the configuration file:
    ${program.name()} create --config`)
        process.exit(1)
    }

    return true
}
function slimConfigRead() {
    slimConfigCheck()

    return readJson(slimConfigPath);
}
function serverConfigRead() {
    try {
        const config = readJson(slimConfigPath)
        if (!config.main) return {}

        const dir = path.dirname(path.resolve(config.main))
        return readJson(path.join(dir, "slimserver.json"))
    } catch {
        return {}
    }
}
function packageCheck() {
    if (!fs.existsSync(packagePath)) {
        error(`package.json was not found in the root folder of the directory`)
        process.exit(1)
    }

    return true
}

program
    .name("slmc")
    .description(`Slim Language CLI (SLMC ${pkg.version})`)
    .version(pkg.version);

program
    .command("build")
    .description("Build a Slim project")
    .option("-S, --silent", "Build without log")
    .option("-R, --release", "Leave runtime type checks out of the output")
    .option("--no-check", "Build without static type checking")
    .option("-F, --force", "Rebuild every file, ignoring the build cache")
    .action((params) => {
        slimConfigCheck()

        if(params.release) process.env.SLIM_RELEASE = "1"
        if(!params.check) process.env.SLIM_NO_CHECK = "1"
        if(params.force) process.env.SLIM_FORCE = "1"

        if(!params.silent) log("Building...")
        if(runScripts([compileScript]) && !params.silent) log("Ready!")
    });

program
    .command("run")
    .description("Build and run a Slim project")
    .option("-S, --silent", "Run without log")
    .option("-D, --dev", "Run with dev features enabled (SLIM_DEV)")
    .option("-R, --release", "Run without runtime type checks")
    .option("--no-check", "Run without static type checking")
    .action((params) => {
        slimConfigCheck()

        if(params.release) process.env.SLIM_RELEASE = "1"
        if(params.dev) process.env.SLIM_DEV = "1"
        if(!params.check) process.env.SLIM_NO_CHECK = "1"
        if(!params.silent) log(params.dev ? "Building and running (dev)..." : "Building and running...")
        runScripts([compileScript], [runScript])
    });

program
    .command("view")
    .description("View the current file to be compiled")
    .option("-L, --line <line>", "View on line")
    .action((params) => {
        const config = slimConfigRead()

        if(!("main" in config)) return

        const file = config.main.endsWith(".slim") ? config.main : config.main + ".slim"
        const mainContent = fs.readFileSync(file, "utf8")

        if(!params.line) {
            console.log(mainContent)
            return
        }

        const lines = mainContent.split(/\r?\n/)
        const line = Number.parseInt(params.line, 10)

        if(line >= 1 && line <= lines.length) console.log(lines[line - 1])
        else error(`Line ${params.line} does not exist. The file has lines 1 to ${lines.length}`)
    });

program
    .command("server")
    .description("Run a Slim server (prod by default; --dev for watch + live reload)")
    .option("-D, --dev", "Dev mode: watch, rebuild, live reload, request logs")
    .option("-H, --hot", "Dev mode with hot reload")
    .option("-R, --release", "Run without runtime type checks")
    .action((params) => {
        slimConfigCheck()

        const dev = Boolean(params.dev || params.hot || serverConfigRead().dev === true)

        if(params.release) process.env.SLIM_RELEASE = "1"

        if(dev) {
            log("Starting Slim dev server (watch + live reload)...")
            runScripts(params.hot ? [devScript, "--hot"] : [devScript])
        }
        else {
            log("Starting Slim server...")
            runScripts([compileScript], [runScript])
        }
    });

program
    .command("config")
    .description("View current Slim config")
    .option("-K, --keys <keys>", "Show only specific keys")
    .option("-S, --set <key>=<value>", "Set key value")
    .option("-R, --remove <key>", "Remove key")
    .action(async (params) => {
        let config
        try {
            config = slimConfigRead()
        } catch (err) {
            error(`slimconfig.json is not valid JSON: ${err.message}`)
            process.exitCode = 1
            return
        }

        if(params.keys) {
            for (const key of splitList(params.keys).map(key => key.replace(/^-+/, ""))) {
                if(key in config) console.log(config[key])
            }
        }
        else if(params.set) {
            for (const arg of splitList(params.set)) {
                const eq = arg.indexOf("=")
                if(eq <= 0) continue
                config[arg.slice(0, eq)] = parseValue(arg.slice(eq + 1))
            }
            writeSlimConfig(config)
        }
        else if(params.remove) {
            for (const key of splitList(params.remove)) delete config[key]
            writeSlimConfig(config)
        }
        else {
            console.log(config)
        }
    });

program
    .command("create")
    .description("Workspace creating")
    .option("--cfg, --config", "Create config")
    .option("--srv, --server", "Create a slimserver.json next to the entry file")
    .option("--file <name>", "Create file")
    .action((params) => {
        if(params.config) {
            try {
                fs.writeFileSync(slimConfigPath, JSON.stringify(defaultConfig, null, 4), 'utf8');
                log('Slim config create in root dir');
            } catch (err) {
                error('An error occurred while creating config:', err);
            }
        }
        if(params.server) {
            try {
                const config = slimConfigRead()
                const dir = config.main ? path.dirname(path.resolve(config.main)) : root
                const serverConfigPath = path.join(dir, "slimserver.json")

                if(fs.existsSync(serverConfigPath)) {
                    log(`slimserver.json already exists at ${path.relative(root, serverConfigPath)}, leaving it untouched`)
                }
                else {
                    const template = {
                        port: 3000,
                        dev: false,
                        statics: [{ from: "/public", to: "./public" }],
                        redirects: [{ from: "/github", to: "https://example.com" }]
                    }
                    fs.writeFileSync(serverConfigPath, JSON.stringify(template, null, 4) + "\n", 'utf8')
                    log(`Created ${path.relative(root, serverConfigPath)}`)
                }
            } catch (err) {
                error('An error occurred while creating slimserver.json:', err);
            }
        }
        if(params.file) {
            try {
                fs.writeFileSync(params.file + ".slim", "", 'utf8');
                log(`File ${params.file}.slim created`);
            } catch (err) {
                error('An error occurred while creating file:', err);
            }
        }
        if(!params.config && !params.server && !params.file) {
            log(
`Please use the following arguments to create files:
    ${program.name()} help create
`)
        }
    });

program
    .command("version")
    .option("--check", "Check actual version")
    .action(async (params) => {
        packageCheck()

        if(params.check) {
            const githubRepo = pkg.repository.url.split("git+https://github.com/")[1].trim().split(".git")[0]
            if(!/^[\w.-]+\/[\w.-]+$/.test(githubRepo)) {
                error("Unable to determine a valid GitHub repository for version check")
                return
            }

            try {
                const res = await fetch("https://raw.githubusercontent.com/" + githubRepo + "/main/package.json")
                if(!res.ok) {
                    error(`Version check failed: received HTTP ${res.status} from GitHub`)
                    return
                }

                const githubPkg = await res.json()
                if(typeof githubPkg?.version !== "string" || !/^\d+\.\d+\.\d+/.test(githubPkg.version)) {
                    error("Version check failed: unexpected response format")
                    return
                }

                if(githubPkg.version != pkg.version) {
                    log(`A different Slim version is available:
    Latest: ${githubPkg.version}
    Yours: ${pkg.version}`)
                }
                else {
                    log(`You are on the latest Slim version`)
                }
            }
            catch (err) {
                error(`Version check failed: ${err?.message ?? err}`)
            }
            return
        }
        console.log(program.version())
    });

program
    .command("log")
    .argument('<string>')
    .action((str) => {
        log(str)
    });

program
    .command("check")
    .action(() => {
        if(slimConfigCheck() != false) {
            log("Everything is OK")
        }
    });

program
    .command("init")
    .description("Scaffold a new Slim project")
    .action(() => {
        packageCheck()

        if (!fs.existsSync(slimConfigPath)) {
            fs.writeFileSync(slimConfigPath, JSON.stringify({ main: "index", uses: { style: "import", enabled: true } }, null, 4), "utf8")
            log("Created slimconfig.json")
        } else {
            log("slimconfig.json already exists, leaving it untouched")
        }

        const entryFile = path.join(root, "index.slim")
        if (!fs.existsSync(entryFile)) {
            fs.writeFileSync(entryFile,
`struct User {
    name: string
    id: int
}

const user: User = { name: "Slim", id: 1 }
log(\`Hello, \${user.name}!\`)
`, "utf8")
            log("Created index.slim")
        } else {
            log("index.slim already exists, leaving it untouched")
        }

        log("Done. Run your project with: slmc run")
    });

program
    .command("repl")
    .description("Start an interactive Slim REPL")
    .action(async () => {
        const { startRepl } = await import("../repl.js")
        startRepl()
    });

program
    .command("test")
    .description("Run Slim test files (*.test.slim)")
    .argument("[file]", "Run a specific test file")
    .action((file) => {
        process.exitCode = runTests(file)
    });

program
    .command("fmt")
    .description("Format Slim source")
    .argument("[file]", "File to format (defaults to the config main)")
    .action((file) => {
        let target = file
        if (!target) {
            const config = slimConfigRead()
            if (!("main" in config)) {
                error(`No file given and no "main" in slimconfig.json`)
                process.exitCode = 1
                return
            }
            target = config.main
        }
        if (!target.endsWith(".slim")) target += ".slim"
        target = path.resolve(target)

        if (!fs.existsSync(target)) {
            error(`File not found: ${target}`)
            process.exitCode = 1
            return
        }

        const changed = formatFile(target)
        log(changed ? `Formatted ${path.relative(root, target)}` : `${path.relative(root, target)} already formatted`)
    });


try {
    program.parse();
}
catch (err) {
    error(err?.message ?? err)
    process.exitCode = 1
}
