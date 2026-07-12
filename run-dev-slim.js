import fs from "fs";
import chokidar from "chokidar";
import { spawn } from "child_process";

const config = JSON.parse(
    fs.readFileSync("slimconfig.json", "utf8")
);

const entry = `dist/${config.main}.js`;
const hot = process.argv.includes("--hot");

let app = null;
let rebuilding = false;
let pending = false;

function run() {
    app = spawn("node", [entry], {
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
        const compiler = spawn("node", ["src/compile.js"], {
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

const watcher = chokidar.watch("local", {
    ignoreInitial: true,
    awaitWriteFinish: {
        stabilityThreshold: 150,
        pollInterval: 50
    },
    ignored: [
        "**/node_modules/**",
        "**/dist/**"
    ]
});

watcher.on("all", (_, file) => {
    console.log(`Changed: ${file}`);
    rebuild();
});

process.on("SIGINT", async () => {
    watcher.close();

    await stop();

    process.exit(0);
});