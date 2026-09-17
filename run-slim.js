#!/usr/bin/env node
import { readFileSync } from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const root = process.cwd();

const config = JSON.parse(readFileSync(path.join(root, 'slimconfig.json'), 'utf8'));
const mainFile = config.main;
const distDir = typeof config.dist === 'string' && config.dist.trim() ? config.dist : 'slim-dist';

const dist = path.join(root, distDir, `${mainFile}.js`);
const args = ['--enable-source-maps', '--no-warnings', dist];

const proc = spawn('node', args, { stdio: 'inherit' });

proc.on('exit', (code) => {
    process.exit(code);
});