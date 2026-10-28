import fs from "node:fs"
import path from "node:path"
import { rootPath } from "../helpers.js"
import { readJson } from "../../modulePaths.js"

export function lockFile(dir = rootPath) {
	return path.join(dir, "spm.lock.json")
}

export function readLock(dir = rootPath) {
	try {
		const data = readJson(lockFile(dir))
		if (!data.packages || typeof data.packages !== "object") data.packages = {}
		return data
	} catch {
		return { packages: {} }
	}
}

export function writeLock(data, dir = rootPath) {
	fs.writeFileSync(lockFile(dir), JSON.stringify(data, null, 4) + "\n", "utf8")
	return data
}

export function setLockEntry(name, entry, dir = rootPath) {
	const lock = readLock(dir)
	lock.packages[name] = entry
	return writeLock(lock, dir)
}

export function removeLockEntry(name, dir = rootPath) {
	const lock = readLock(dir)
	if (name in lock.packages) {
		delete lock.packages[name]
		writeLock(lock, dir)
	}
	return lock
}
