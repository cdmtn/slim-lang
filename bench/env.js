// Environment fingerprint stored in every report. No absolute paths.
import os from "node:os"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// Fields that must match for two reports to be comparable.
export const COMPARABLE_ENV = ["node", "v8", "platform", "arch", "cpu_model", "cores"]

const git = args => {
    const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" })
    return r.status === 0 ? r.stdout.trim() : null
}

export function captureEnv() {
    const cpus = os.cpus()
    const status = git(["status", "--porcelain", "--", ".", ":!target", ":!bench/baselines"])
    return {
        node: process.versions.node,
        v8: process.versions.v8,
        platform: os.platform(),
        os_release: os.release(),
        arch: os.arch(),
        cpu_model: cpus[0]?.model ?? "unavailable",
        cores: cpus.length,
        total_mem_mb: Math.round(os.totalmem() / 1048576),
        git_commit: git(["rev-parse", "--short=12", "HEAD"]),
        git_dirty: status === null ? null : status.length > 0,
        slim_version: JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version
    }
}

// Timer cost: median back-to-back performance.now() delta, in ms.
export function timerOverheadMs() {
    const deltas = []
    for (let i = 0; i < 2000; i++) {
        const a = performance.now()
        deltas.push(performance.now() - a)
    }
    deltas.sort((x, y) => x - y)
    return deltas[deltas.length >> 1]
}
