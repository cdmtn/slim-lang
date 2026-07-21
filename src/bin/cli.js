#!/usr/bin/env node

import { Command } from "commander";
import { execSync } from "child_process";
import { readFile } from 'node:fs/promises';
import path from "node:path"
import fs from "node:fs"

import { log, error, parseValue } from "./helpers.js"

import pkg from "../../package.json" with { type: "json" };

const root = process.cwd()
const program = new Command();
const slimConfigPath = path.join(root, "slimconfig.json")
const packagePath = path.join(root, "package.json")
const spaceRegex = /\s/gm

function slimConfigCheck() {
    packageCheck()

    if (!fs.existsSync(slimConfigPath)) {
        error(`The configuration file does not exist, or it is not in the root directory. You can create the configuration file:
    ${program.name()} create --config`)
        return false
    }
}
function slimConfigRead() {
    slimConfigCheck()

    return JSON.parse(fs.readFileSync(slimConfigPath, "utf8"));
}
function packageCheck() {
    if (!fs.existsSync(packagePath)) {
        error(`package.json was not found in the root folder of the directory`)
        return false
    }
}

program
    .name("slmc")
    .description(`Slim Language CLI (SLMC ${pkg.version})`)
    .version(pkg.version);

program
    .command("compile")
    .description("Compile a Slim project")
    .option("-S, --silent", "Compile without log")
    .action((params) => {
        slimConfigCheck()

        if(!params.silent) log("Compiling...")
        execSync("node src/compile.js", { stdio: "inherit" });
        if(!params.silent) log("Ready!")
    });

program
    .command("run")
    .description("Compile and run a Slim project")
    .option("-S, --silent", "Compile without log")
    .action((params) => {
        slimConfigCheck()

        if(!params.silent) log("Compiling and running...")
        execSync("node src/compile.js && node run-slim.js", { stdio: "inherit" });
    });

program
    .command("view")
    .description("View the current file to be compiled")
    .option("-L, --line <line>", "View on line")
    .action((params) => {
        const config = slimConfigRead()
        
        if("main" in config) {
            const mainContent = fs.readFileSync(config.main + ".slim", "utf8")
            
            if(params["line"]) {
                try {
                    let line = parseInt(params.line) - 1
                    const lines = mainContent.split("\n")
                    const lineContent = lines[line]

                    if(lineContent != undefined) {
                        console.log(mainContent.split("\n")[line])
                    }
                    else {
                        error(`Line ${line + 1} does not exist. The file contains between 1 and ${lines.length} line(-s)`)
                    }
                }
                catch(e) {
                    error(e)
                    return
                }
            }
            else {
                console.log(mainContent)
            }
        }
    });

program
    .command("server")
    .description("Compile and run a Slim server")
    .option("-H, --hot", "Run server with hot reload")
    .action((hot) => {
        log("Compiling and running server...")
        
        if(hot["hot"]) {
            execSync("node run-dev-slim.js --hot", { stdio: "inherit" });
        }
        else {
            execSync("node run-dev-slim.js", { stdio: "inherit" });
        }
    });

program
    .command("config")
    .description("View current Slim config")
    .option("-K, --keys <keys>", "Show only specific keys")
    .option("-S, --set <key>=<value>", "Set key value")
    .option("-R, --remove <key>", "Remove key")
    .action(async (params) => {
        slimConfigCheck()

        try {
            let data = await readFile(path.join(root, "slimconfig.json"), 'utf8');
            const res = JSON.parse(data);

            if(params["keys"]) {
                const args = params["keys"].split(spaceRegex).map(item => item.trim())

                if(args.length > 0) {
                    args.forEach(a => {
                        a = a.replaceAll("--", "")
                        if(a in res) {
                            console.log(res[a])
                        }
                    })
                }
                else {
                    console.log(res)
                }
            }
            else if(params["set"]) {
                const config = JSON.parse(fs.readFileSync(slimConfigPath, "utf8"));
                const args = params["set"].split(spaceRegex).map(item => item.trim());

                args.forEach(arg => {
                    if (!arg.includes("=")) return;

                    const [key, ...valueParts] = arg.split("=");

                    const value = valueParts.join("=").trim();

                    config[key.trim()] = parseValue(value);
                });

                fs.writeFileSync(
                    slimConfigPath,
                    JSON.stringify(config, null, 4),
                    "utf8"
                );
            }
            else if (params["remove"]) {
                const config = JSON.parse(fs.readFileSync(slimConfigPath, "utf8"));
                const keys = params["remove"]
                    .split(spaceRegex)
                    .map(item => item.trim())
                    .filter(Boolean);

                keys.forEach(key => {
                    delete config[key];
                });

                fs.writeFileSync(
                    slimConfigPath,
                    JSON.stringify(config, null, 4),
                    "utf8"
                );
            }
            else {
                const config = JSON.parse(fs.readFileSync(slimConfigPath, "utf8"));
                console.log(config)
            }
        } catch (err) {
            console.error(err);
        }
    });

program
    .command("create")
    .description("Workspace creating")
    .option("--cfg, --config", "Create config")
    .option("--file <name>", "Create file")
    .action(async (params) => {
        if(params.config) {
            const defaultConfigContent = JSON.stringify({
                main: "path/to/slim"
            }, null, 4)

            fs.writeFile(slimConfigPath, defaultConfigContent, 'utf8', (err) => {
                if (err) {
                    error('An error occurred while creating config:', err);
                    return;
                }
                log('Slim config create in root dir');
            });
        }
        if(params.file) {
            fs.writeFile(params.file + ".slim", "", 'utf8', (err) => {
                if (err) {
                    error('An error occurred while creating config:', err);
                    return;
                }
                log(`File ${params.file}.slim created`);
            });
        }
        else {
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
            const res = await fetch("https://raw.githubusercontent.com/" + githubRepo + "/main/package.json")
            const githubPkg = await res.json()

            if(githubPkg.version != pkg.version) {
                log(`Your version is not compatible with the latest version of Slim:
    Current: ${githubPkg.version}
    Your's: ${pkg.version}`)
            }
            else {
                log(`You on the latest Slim version`)
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

program.parse();