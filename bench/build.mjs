import { transform } from "../src/transform.js"
import { readFileSync, writeFileSync } from "fs"
const { code } = transform(readFileSync(new URL("./bench.slim", import.meta.url), "utf8"), "bench.slim", { release: true, outFile: "bench.js" })
writeFileSync(new URL("./bench.js", import.meta.url), code.replace(/^import\s+[^;]*(?:defaults|core)\.js";$/m, `import "/src/external/defaults.js";`))
