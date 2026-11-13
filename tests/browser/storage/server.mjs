import { build } from 'vite'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const output = await mkdtemp(join(tmpdir(), 'search-storage-'))
try {
    await build({ root, configFile: false, envDir: false, publicDir: false,
        build: { outDir: output, emptyOutDir: true, rollupOptions: { input: join(root, 'tests/browser/storage/entry.mjs'), output: { entryFileNames: 'entry.js' } } } })
    const js = await readFile(join(output, 'entry.js'))
    const server = createServer((req, res) => {
        if (req.url === '/entry.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(js); return }
        if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Synthetic storage harness</title><script type="module" src="/entry.js"></script>'); return }
        res.writeHead(404); res.end()
    })
    server.listen(4178, '127.0.0.1')
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(async () => { await rm(output, { recursive: true, force: true }); process.exit(0) }))
} catch (error) { await rm(output, { recursive: true, force: true }); throw error }
