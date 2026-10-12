import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const compiler = path.resolve('src/compile.js')
const cli = path.resolve('src/bin/cli.js')
function project(t, files, config = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'slim-incremental-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const put = (file, text) => {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
        writeFileSync(path.join(dir, file), text)
    }
    put('package.json', '{"type":"module"}')
    put('slimconfig.json', JSON.stringify({ main: 'index', ...config }))
    for (const [file, text] of Object.entries(files)) put(file, text)
    const build = (flags = [], env = {}) => {
        const r = spawnSync(process.execPath, [compiler, '--stats-json', ...flags], {
            cwd: dir, encoding: 'utf8', env: { ...process.env, SLIM_NO_CHECK: '0', SLIM_RELEASE: '0', ...env }
        })
        const stats = r.stdout.split('\n').find(line => line.startsWith('slim-build-stats '))
        return { ...r, stats: stats ? JSON.parse(stats.slice(17)) : null }
    }
    const ok = (flags, env) => { const r = build(flags, env); assert.equal(r.status, 0, r.stderr); return r }
    const output = name => path.join(dir, 'slim-dist', name)
    return { dir, put, build, ok, output }
}
const files = {
    'index.slim': 'use { a } from "./a"\nuse { b } from "./b"\nlog(a(), b())',
    'a.slim': 'use { leaf } from "./leaf"\nexport func a() -> int { return leaf() }',
    'leaf.slim': 'export func leaf() -> int { return 1 }',
    'b.slim': 'export func b() -> int { return 2 }'
}

test('warm build compiles zero modules, preserves bytes/mtime and explain output', t => {
    const p = project(t, files)
    const cold = p.ok(['--explain-checks'])
    assert.equal(cold.stats.compiled.length, 4)
    const paths = ['index.js', 'a.js', 'leaf.js', 'b.js']
    const snapshot = paths.map(n => [readFileSync(p.output(n), 'utf8'), statSync(p.output(n)).mtimeMs])
    const warm = p.ok(['--explain-checks'])
    assert.deepEqual(warm.stats.compiled, [])
    assert.equal(warm.stats.cached.length, 4)
    assert.deepEqual(paths.map(n => [readFileSync(p.output(n), 'utf8'), statSync(p.output(n)).mtimeMs]), snapshot)
    assert.equal(cold.stdout.slice(cold.stdout.indexOf('Runtime checks:')), warm.stdout.slice(warm.stdout.indexOf('Runtime checks:')))
    p.ok(['--clean'])
    assert.deepEqual(paths.map(n => readFileSync(p.output(n), 'utf8')), snapshot.map(s => s[0]))
})

test('leaf changes rebuild only the leaf and transitive dependents', t => {
    const p = project(t, files)
    p.ok()
    p.put('leaf.slim', files['leaf.slim'].replace('return 1', 'return 3'))
    const r = p.ok()
    assert.deepEqual(r.stats.compiled, ['a.slim', 'index.slim', 'leaf.slim'])
    assert.deepEqual(r.stats.cached, ['b.slim'])
    assert.deepEqual(p.ok().stats.compiled, [])
})

test('cached type summaries preserve cold-build diagnostics', t => {
    const p = project(t, files)
    p.ok()
    p.put('index.slim', 'use { leaf } from "./leaf"\nlet s: string = leaf()')
    const warm = p.build()
    const cold = p.build(['--no-cache'])
    assert.equal(warm.status, 1)
    assert.equal(warm.stderr, cold.stderr)
    assert.match(warm.stderr, /"s" expects string, got int/)
})

test('cycles include every reachable dependency in invalidation', t => {
    const p = project(t, {
        'index.slim': 'use "./a"',
        'a.slim': 'use "./b"\nuse "./leaf"',
        'b.slim': 'use "./a"',
        'leaf.slim': 'log(1)'
    })
    p.ok()
    assert.deepEqual(p.ok().stats.compiled, [])
    p.put('leaf.slim', 'log(2)')
    assert.deepEqual(p.ok().stats.compiled, ['a.slim', 'b.slim', 'index.slim', 'leaf.slim'])
})

test('deleted sources and unused declarations are removed from output', t => {
    const p = project(t, files, { declarations: true })
    p.ok()
    assert.ok(existsSync(p.output('b.d.ts')))
    rmSync(path.join(p.dir, 'b.slim'))
    assert.equal(p.build().status, 1)
    assert.equal(existsSync(p.output('b.js')), false)
    assert.equal(existsSync(p.output('b.d.ts')), false)
    p.put('index.slim', 'use "./a"')
    p.ok()
    p.put('slimconfig.json', '{"main":"index","declarations":false}')
    p.ok()
    assert.equal(existsSync(p.output('a.d.ts')), false)
})

test('relevant options invalidate cache and corrupt output is repaired', t => {
    const p = project(t, { 'index.slim': 'let x: int = 1' })
    p.ok()
    for (const config of [{ jsdoc: true }, { declarations: true }, {}]) {
        p.put('slimconfig.json', JSON.stringify({ main: 'index', ...config }))
        assert.deepEqual(p.ok().stats.compiled, ['index.slim'])
        assert.deepEqual(p.ok().stats.compiled, [])
    }
    assert.equal(p.ok([], { SLIM_RELEASE: '1' }).stats.compiled.length, 1)
    assert.equal(p.ok([], { SLIM_NO_CHECK: '1' }).stats.compiled.length, 1)
    p.put('slim-dist/index.js', 'broken')
    assert.equal(p.ok().stats.compiled.length, 1)
    p.put('slim-dist/.slim-build-cache.json', 'broken')
    assert.equal(p.ok().stats.compiled.length, 1)
})

test('same-line uses participate in the graph; text in strings does not', t => {
    const p = project(t, {
        'index.slim': 'use "./a"; use "./b";\nconst s = "use @missing"',
        'a.slim': 'log(1)', 'b.slim': 'log(2)'
    })
    assert.deepEqual(p.ok().stats.compiled, ['a.slim', 'b.slim', 'index.slim'])
    p.put('b.slim', 'log(3)')
    assert.deepEqual(p.ok().stats.compiled, ['b.slim', 'index.slim'])
})

test('CLI clean and explain flags work on both cold and cached builds', t => {
    const p = project(t, { 'index.slim': 'let x: int = 1' })
    const run = flags => spawnSync(process.execPath, [cli, 'build', '--stats', '--explain-checks', ...flags], { cwd: p.dir, encoding: 'utf8' })
    assert.match(run([]).stdout, /Compiled 1, cached 0/)
    assert.match(run([]).stdout, /Compiled 0, cached 1/)
    const clean = run(['--clean'])
    assert.equal(clean.status, 0, clean.stderr)
    assert.match(clean.stdout, /1:1\s+removed/)
    assert.match(clean.stdout, /Compiled 1, cached 0/)
})

test('dev watcher rebuilds through the same cache', { timeout: 15000 }, async t => {
    const { spawn } = await import('node:child_process')
    const p = project(t, files)
    p.ok()
    const child = spawn(process.execPath, [path.resolve('run-dev-slim.js')], { cwd: p.dir, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    t.after(async () => {
        if (child.exitCode !== null) return
        const exited = new Promise(resolve => child.once('exit', resolve))
        child.kill('SIGINT')
        await exited
    })
    async function until(pattern) {
        const end = Date.now() + 10000
        while (!pattern.test(output)) {
            assert.ok(Date.now() < end, output)
            await new Promise(resolve => setTimeout(resolve, 25))
        }
    }
    await until(/Compiled 0, cached 4[\s\S]*Ready/)
    output = ''
    p.put('leaf.slim', files['leaf.slim'].replace('return 1', 'return 4'))
    await until(/Compiled 3, cached 1[\s\S]*Ready/)
    assert.ok(existsSync(p.output('.slim-build-cache.json')))
})

test('a primitive redefined by a sibling disables elision across the runtime registry', t => {
    const p = project(t, {
        'index.slim': 'use "./override"\nuse "./consumer"',
        'override.slim': 'type int(v) { return false }',
        'consumer.slim': 'let n: int = 1'
    })
    p.ok()
    assert.match(readFileSync(p.output('consumer.js'), 'utf8'), /__typed_variable__/)
    p.put('override.slim', 'log("no override")')
    const changed = p.ok()
    assert.ok(changed.stats.compiled.includes('consumer.slim'))
    assert.doesNotMatch(readFileSync(p.output('consumer.js'), 'utf8'), /__typed_variable__/)
})

test('runtime copies are repaired without recompiling and obsolete runtime files are removed', t => {
    const p = project(t, { 'index.slim': 'log(1)' })
    p.ok()
    p.put('slim-dist/external/core.js', 'broken')
    p.put('slim-dist/external/obsolete.js', 'stale')
    assert.deepEqual(p.ok().stats.compiled, [])
    assert.equal(readFileSync(p.output('external/core.js'), 'utf8'), readFileSync(path.resolve('src/external/core.js'), 'utf8'))
    assert.equal(existsSync(p.output('external/obsolete.js')), false)
})

test('compiler version is part of the persistent cache identity', async t => {
    const { BuildCache, compilerFingerprint, fileHash } = await import('../src/buildCache.js')
    const p = project(t, { 'index.slim': 'log(1)' })
    p.ok()
    const first = compilerFingerprint({}, 'first-version')
    const second = compilerFingerprint({}, 'second-version')
    assert.notEqual(first, second)
    const cache = new BuildCache(path.dirname(p.output('index.js')), first)
    cache.store('index.slim', { key: 'same-source', output: p.output('index.js'), outputHash: fileHash(p.output('index.js')) })
    cache.save()
    assert.ok(new BuildCache(path.dirname(p.output('index.js')), first).lookup('index.slim', 'same-source'))
    assert.equal(new BuildCache(path.dirname(p.output('index.js')), second).lookup('index.slim', 'same-source'), null)
})

test('cached structs and enums preserve diagnostics, including aliases', t => {
    const p = project(t, {
        'index.slim': 'use { Point as P, Role } from "./types"\nlet p: P = { x: 1, role: Role.Member }',
        'types.slim': 'export enum Role { Member: 1 }\nexport struct Point { x: int\n role: Role }'
    })
    p.ok()
    p.put('index.slim', 'use { Point as P, Role } from "./types"\nlet p: P = { x: "bad", role: Role.Member }')
    const warm = p.build()
    const cold = p.build(['--no-cache'])
    assert.equal(warm.status, 1)
    assert.match(warm.stderr, /P.x.*expects int/)
    assert.equal(warm.stderr, cold.stderr)
})
