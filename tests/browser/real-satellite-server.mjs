// Opt-in browser stand for the accepted A10.2 test HTTP environment.
// It serves the real entry with real basemap resources and proxies /api to a
// separately started test server (default http://i2-satellite-http:18766).
// It never reads .env, never changes public/build and must not be used as a
// production server.
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

const root = fileURLToPath(new URL('../../', import.meta.url))
const output = await mkdtemp(join(tmpdir(), 'satellite-real-'))
const apiTarget = process.env.SATELLITE_TEST_API ?? 'http://i2-satellite-http:18766'
const port = Number(process.env.SATELLITE_TEST_PORT ?? 4180)

try {
    await build({
        root, configFile: false, envDir: false, base: '/', publicDir: false,
        resolve: { alias: { '@': join(root, 'resources/js') } },
        plugins: [vue(), tailwindcss()],
        build: { outDir: output, emptyOutDir: true, manifest: 'manifest.json', rollupOptions: { input: join(root, 'tests/browser/entry.mjs') } },
    })
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
    const entry = manifest['tests/browser/entry.mjs']
    let html = await readFile(join(root, 'resources/views/welcome.blade.php'), 'utf8')
    const directive = "@vite(['resources/css/app.css', 'resources/js/app.js'])"
    if (!html.includes('@fonts') || !html.includes(directive)) throw new Error('Update real stand for the changed Blade shell.')
    const styles = new Set(), visited = new Set()
    function collectStyles(key) {
        if (visited.has(key)) return
        visited.add(key)
        const chunk = manifest[key]
        if (!chunk) throw Error(`Missing static chunk: ${key}`)
        for (const imported of chunk.imports ?? []) collectStyles(imported)
        for (const css of chunk.css ?? []) styles.add(css)
    }
    collectStyles('tests/browser/entry.mjs')
    html = html.replace('@fonts', '').replace(directive, [...styles].map(css => `<link rel="stylesheet" href="/${css}">`).join('') + `<script type="module" src="/${entry.file}"></script>`)

    const server = createServer(async (req, res) => {
        const url = new URL(req.url, `http://127.0.0.1:${port}`)
        const pathname = url.pathname
        if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return }
        if (['/analysis', '/search', '/compare', '/trips'].includes(pathname) || pathname.startsWith('/address/')) {
            res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end(); return
        }
        if (pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return }
        if (pathname.startsWith('/api/')) {
            try {
                const chunks = []
                for await (const chunk of req) chunks.push(chunk)
                const headers = { ...req.headers }
                delete headers.host; delete headers.connection; delete headers['content-length']
                const upstream = await fetch(`${apiTarget}${pathname}${url.search}`, {
                    method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
                })
                const body = Buffer.from(await upstream.arrayBuffer())
                const responseHeaders = {
                    'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
                    'Cache-Control': upstream.headers.get('cache-control') ?? 'no-store',
                    'Referrer-Policy': upstream.headers.get('referrer-policy') ?? 'no-referrer',
                    'X-Content-Type-Options': 'nosniff',
                }
                res.writeHead(upstream.status, responseHeaders); res.end(body)
            } catch {
                res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
                res.end('{"code":"TEST_UPSTREAM_UNAVAILABLE","message":"Test API is unavailable."}')
            }
            return
        }
        const relative = normalize(pathname).replace(/^([/\\])+/, '')
        const publicPath = /^maps\//.test(relative) ? join(root, 'public', relative)
            : /^(assets|build)\//.test(relative) ? join(output, relative) : null
        if (publicPath && !publicPath.includes('..')) {
            try {
                const type = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png',
                    '.json': 'application/json', '.svg': 'image/svg+xml' }[extname(publicPath)] ?? 'application/octet-stream'
                const body = await readFile(publicPath)
                res.writeHead(200, { 'Content-Type': type }); res.end(body); return
            } catch { /* Explicit 404 below. */ }
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found')
    })
    server.on('error', async error => { console.error(error); await rm(output, { recursive: true, force: true }); process.exit(1) })
    server.listen(port, '0.0.0.0', () => console.log(`Satellite real stand: http://127.0.0.1:${port} -> ${apiTarget}`))
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { await rm(output, { recursive: true, force: true }); process.exit(0) }))
} catch (error) { await rm(output, { recursive: true, force: true }); throw error }
