import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import chokidar from "chokidar";
import { spawn } from "child_process";

// This script ships in the package; the compiler sits next to it there.
const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const compileScript = path.join(packageRoot, "src", "compile.js");

const config = JSON.parse(
    fs.readFileSync("slimconfig.json", "utf8")
);

const entry = `dist/${config.main}.js`;
const hot = process.argv.includes("--hot");

let app = null;
let rebuilding = false;
let pending = false;

function run() {
    app = spawn("node", ["--enable-source-maps", "--no-warnings", entry], {
        stdio: "inherit",
        detached: process.platform !== "win32",
        env: {
            ...process.env,
            SLIM_DEV: "1",
            SLIM_HOT: hot ? "1" : "0"
        }
    });

    app.on("exit", code => {
        if (code && code !== 0)
            console.log(`Application exited with code ${code}`);
    });
}

function stop() {
    return new Promise(resolve => {
        if (!app || app.killed) {
            app = null;
            return resolve();
        }

        const proc = app;

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
    return new Promise(resolve => {
        const compiler = spawn("node", [compileScript], {
            stdio: "inherit"
        });

        compiler.on("exit", code => {
            resolve(code === 0);
        });
    });
}

async function rebuild() {
    if (rebuilding) {
        pending = true;
        return;
    }

    rebuilding = true;

    console.clear();
    console.log("Compiling...");

    const ok = await compile();

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

const watcher = chokidar.watch(watchTarget, {
    ignoreInitial: true,
    awaitWriteFinish: {
        stabilityThreshold: 150,
        pollInterval: 50
    },
    ignored: p => /(^|[\\/])(node_modules|dist|\.git)([\\/]|$)/.test(p)
});

watcher.on("all", (_, file) => {
    if (!file || !file.endsWith(".slim")) return;
    console.log(`Changed: ${file}`);
    rebuild();
});

process.on("SIGINT", async () => {
    watcher.close();

    await stop();

    process.exit(0);
});