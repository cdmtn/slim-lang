import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import chokidar from "chokidar";
import { spawn } from "child_process";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(packageRoot, "src", "handlers", "errorHandler.js")).href);
const { build } = await import(pathToFileURL(path.join(packageRoot, "src", "compile.js")).href);
const { readJson, distDirName } = await import(pathToFileURL(path.join(packageRoot, "src", "modulePaths.js")).href);

const config = readJson("slimconfig.json");

if (typeof config.main !== "string" || !config.main.trim()) {
    console.error('slimconfig.json has no "main" entry');
    process.exit(1);
}

const slimConfigFile = path.resolve("slimconfig.json");
let main = config.main;

function serverConfigFile(main) {
    return path.join(path.dirname(path.resolve(main)), "slimserver.json");
}

function refreshEntry() {
    try {
        const fresh = readJson(slimConfigFile);
        if (typeof fresh.main === "string" && fresh.main.trim()) main = fresh.main;
        return fresh;
    } catch {
        return config;
    }
}

let app = null;
let rebuilding = false;
let pending = false;
const stopped = new WeakSet();

function run() {
    const entry = path.resolve(distDirName(), `${main}.js`);
    const proc = spawn(process.execPath, ["--enable-source-maps", "--no-warnings", entry], {
        stdio: ["inherit", "inherit", "inherit", "ipc"],
        detached: process.platform !== "win32",
        env: {
            ...process.env,
            SLIM_DEV: "1"
        }
    });

    app = proc;

    proc.on("exit", code => {
        if (app === proc) app = null;
        if (code && code !== 0 && !stopped.has(proc))
            console.log(`Application exited with code ${code}`);
    });
}

function stop() {
    return new Promise(resolve => {
        if (!app || app.killed || app.exitCode !== null || app.signalCode !== null) {
            app = null;
            return resolve();
        }

        const proc = app;
        stopped.add(proc);

        proc.once("exit", () => {
            app = null;
            resolve();
        });

        const killTree = signal => {
            if (process.platform === "win32") {
                spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"]);
            } else {
                try {
                    process.kill(-proc.pid, signal);
                } catch {
                    proc.kill(signal);
                }
            }
        };

        killTree("SIGTERM");

        setTimeout(() => {
            if (app === proc && !proc.killed) {
                killTree("SIGKILL");
            }
        }, 1000);
    });
}

function compile() {
    const started = performance.now();
    const ok = build();
    if (ok) console.log(`Compiled in ${Math.round(performance.now() - started)}ms`);
    return ok;
}

async function rebuild() {
    if (rebuilding) {
        pending = true;
        return;
    }

    rebuilding = true;

    console.clear();
    console.log("Compiling...");

    const ok = compile();

    if (ok) {
        await stop();
        run();
        console.log("Ready");
    }

    rebuilding = false;

    if (pending) {
        pending = false;
        rebuild();
    }
}

await rebuild();

const watchTarget = config.watch ?? ".";
function isIgnored(file) {
    const abs = path.resolve(file);
    const distPath = path.resolve(distDirName());
    if (abs === distPath || abs.startsWith(distPath + path.sep)) return true;
    return file.split(/[\\/]/).some(part => part === "node_modules" || part === ".git");
}

let serverConfig = serverConfigFile(config.main);

const watcher = chokidar.watch([watchTarget, slimConfigFile, serverConfig], {
    ignoreInitial: true,
    awaitWriteFinish: {
        stabilityThreshold: 150,
        pollInterval: 50
    },
    ignored: isIgnored
});

watcher.on("all", (_, file) => {
    if (!file) return;
    const abs = path.resolve(file);
    const isConfig = abs === slimConfigFile || abs === serverConfig;
    if (file.endsWith(".css")) {
        console.log(`Changed: ${file}`);
        if (app?.connected) app.send({ slimCss: path.basename(file) });
        return;
    }
    if (!isConfig && !file.endsWith(".slim")) return;
    console.log(`Changed: ${file}`);
    if (abs === slimConfigFile) {
        const fresh = refreshEntry();
        const nextServerConfig = typeof fresh.main === "string" && fresh.main.trim() ? serverConfigFile(fresh.main) : serverConfig;
        if (nextServerConfig !== serverConfig) {
            serverConfig = nextServerConfig;
            watcher.add(serverConfig);
        }
    }
    rebuild();
});

process.on("SIGINT", async () => {
    watcher.close();

    await stop();

    process.exit(0);
});