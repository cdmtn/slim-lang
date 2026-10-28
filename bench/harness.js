// Times each operation like js-framework-benchmark: from the call to the end of style and layout
// (total), and the part spent in the framework's own code (script). Frameworks take turns sample by
// sample, so a machine that speeds up or slows down affects all of them alike.
export async function compare(frameworks, runs = 15) {
    const frame = () => new Promise(resolve => setTimeout(resolve, 16))
    const settle = () => document.body.offsetHeight
    const time = fn => {
        const start = performance.now()
        fn()
        const script = performance.now() - start
        settle()
        return [script, performance.now() - start]
    }
    const cases = [
        ["create 1,000 rows", ops => ops.clear(), ops => ops.run()],
        ["replace 1,000 rows", ops => ops.run(), ops => ops.run()],
        ["update every 10th row", ops => ops.run(), ops => ops.update()],
        ["select row", ops => ops.run(), ops => ops.select()],
        ["swap rows", ops => ops.run(), ops => ops.swap()],
        ["remove row", ops => ops.run(), ops => ops.remove()],
        ["create 10,000 rows", ops => ops.clear(), ops => ops.runLots()],
        ["append 1,000 rows", ops => ops.run(), ops => ops.add()],
        ["clear 1,000 rows", ops => ops.run(), ops => ops.clear()]
    ]
    const median = values => +values.sort((a, b) => a - b)[Math.floor(values.length / 2)].toFixed(2)
    const results = {}
    for (const [label, setup, op] of cases) {
        const samples = Object.fromEntries(Object.keys(frameworks).map(name => [name, { script: [], total: [] }]))
        for (let i = 0; i < runs; i++) {
            for (const [name, ops] of Object.entries(frameworks)) {
                for (const other of Object.values(frameworks)) other.clear()
                settle()
                setup(ops)
                settle()
                await frame()
                const [script, total] = time(() => op(ops))
                samples[name].script.push(script)
                samples[name].total.push(total)
                await frame()
            }
        }
        results[label] = Object.fromEntries(Object.entries(samples).map(([name, { script, total }]) =>
            [name, { script: median(script), total: median(total) }]))
    }
    for (const ops of Object.values(frameworks)) ops.clear()
    window.benchResults = results
    document.getElementById("out").textContent = JSON.stringify(results, null, 2)
    return results
}
