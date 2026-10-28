// Serves the repository, so the benchmark page can import the runtime from /src/external/
import { createServer } from "http"
import { readFile } from "fs/promises"
import path from "path"

const root = path.resolve(import.meta.dirname, "..")
const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html" }

createServer(async (req, res) => {
    let file = path.join(root, decodeURIComponent(new URL(req.url, "http://localhost").pathname))
    if (file.endsWith(path.sep)) file = path.join(file, "index.html")
    if (!file.startsWith(root + path.sep)) {
        res.writeHead(403)
        res.end()
        return
    }
    try {
        const body = await readFile(file)
        res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "text/plain" })
        res.end(body)
    } catch {
        res.writeHead(404)
        res.end()
    }
}).listen(5178, () => console.log("http://localhost:5178/bench/"))
