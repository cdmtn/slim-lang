import fs from "node:fs";
import path from "node:path";
import { rm, mkdir } from 'node:fs/promises';
import chalk from "chalk";

export const formatError = chalk.red.bold
export const formatSuccess = chalk.green.bold
export const formatBgWhite = chalk.bgWhiteBright
export const formatItalic = chalk.italic
export const formatBold = chalk.bold
export const rootPath = process.cwd()
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseValue(value) {
    if(value == "true" || value == "false") {
        return value == "true"
    }
    if(/^-?\d*\.?\d*$/.test(value)) {
        return parseFloat(value)
    }

    return value
}

export function log(...text) {
    console.log(`[SLIM CLI]`, ...text)
}
export function error(...text) {
    console.error(`[SLIM CLI]`, ...text)
}

export function isPackageExists(name) {
	return fs.existsSync(path.join(rootPath, "packages", name))
}
export function getPackagePath(name) {
	return path.join(rootPath, "packages", name)
}

export async function deleteDirectory(dirPath) {
	try {
		await rm(dirPath, { recursive: true, force: true });
		return true
	} catch (err) {
		return false
	}
}

export async function loading({ startMsg, callback }) {
	function fail(...args) {
		return {
			success: false,
			msg: args.join(" ")
		}
	}
	function ok(...args) {
		return {
			success: true,
			msg: args.join(" ")
		}
	}

    const spinChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;

    const render = (char, msg) => {
        process.stdout.write(
            `\r\x1b[2K${chalk.green.bold(`[SPM] ${char} ${msg}`)}`
        );
    };

    const spinnerInterval = setInterval(() => {
        render(spinChars[i++ % spinChars.length], startMsg);
	}, 100);

    try {
        const result = await callback({ fail, ok });

        clearInterval(spinnerInterval);

        process.stdout.write('\r\x1b[2K');

        if (!result || typeof result.success !== 'boolean') {
            return {
                success: false,
                msg: 'Invalid callback result'
            };
        }

        const icon = result.success ? '✓' : '✗';

        process.stdout.write(
            `${chalk.green.bold(`[SPM] ${icon} ${result.msg}`)}\n`
        );

        return result;
    } catch (error) {
        clearInterval(spinnerInterval);

        process.stdout.write('\r\x1b[2K');

        const result = {
            success: false,
            msg: error instanceof Error ? error.message : String(error)
        };

        process.stdout.write(
            `${chalk.red.bold(`[SPM] ✗ ${result.msg}`)}\n`
        );

        return result;
    }
}

export async function createFolder(path) {
	try {
		await mkdir(path, { recursive: true });
		return { success: true }
	} catch (err) {
		return {
			success: false,
			content: err.message
		}
	}
}

export function createFile(filePath, content) {
    try {
        const normalized = content
            .replace(/^\s*\n/, "")
            .replace(/\n\s*$/, "")
            .replace(/^[ \t]+/gm, line => {
                return line.replace(/^[ \t]{0,7}/, "");
            });

        fs.writeFileSync(filePath, normalized);

		return {
			success: true
		}
    }
    catch (err) {
        return {
            success: false,
            content: err.message
        };
    }
}