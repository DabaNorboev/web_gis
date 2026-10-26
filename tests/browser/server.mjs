import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

const root = fileURLToPath(new URL('../../', import.meta.url))
const output = await mkdtemp(join(tmpdir(), 'compare-smoke-'))
const basemapPath = join(root, 'resources/js/maps/basemap.json')
const originalStyle = JSON.parse(await readFile(basemapPath, 'utf8'))
// Use the real renderer, overlays, controls and attribution, with no remote map
// resources. The source is empty; the synthetic analytical layers remain real.
const offlineStyle = {
    version: 8, sprite: '/smoke-sprite',
    sources: { offline: {
        type: 'geojson', data: '/smoke-background.json',
        attribution: Object.values(originalStyle.sources).map(source => source.attribution ?? '').join(' · '),
    } },
    layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#edf0e9' } },
        { id: 'offline', type: 'circle', source: 'offline' },
    ],
}
try {
    // Build the actual app into a disposable directory. No Laravel plugin means
    // no font-provider network calls, .env access, public/hot or localhost assets.
    await build({
        root, configFile: false, envDir: false, base: '/', publicDir: false,
        resolve: { alias: { '@': join(root, 'resources/js') } },
        plugins: [
            { name: 'smoke-offline-style', enforce: 'pre', load(id) { if (id.split('?')[0] === basemapPath) return JSON.stringify(offlineStyle) } },
            vue(), tailwindcss(),
        ],
        build: { outDir: output, emptyOutDir: true, manifest: 'manifest.json', rollupOptions: { input: join(root, 'tests/browser/entry.mjs') } },
    })
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
    const entry = manifest['tests/browser/entry.mjs']
    let html = await readFile(join(root, 'resources/views/welcome.blade.php'), 'utf8')
    const directive = "@vite(['resources/css/app.css', 'resources/js/app.js'])"
    if (!html.includes('@fonts') || !html.includes(directive)) throw new Error('Update smoke asset handling for the changed Blade shell.')
    html = html.replace('@fonts', '').replace(directive, (entry.css ?? []).map(css => `<link rel="stylesheet" href="/${css}">`).join('') + `<script type="module" src="/${entry.file}"></script>`)
    const server = createServer(async (req, res) => {
        const pathname = new URL(req.url, 'http://127.0.0.1').pathname
        if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return }
        if (pathname === '/smoke-background.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"type":"FeatureCollection","features":[]}'); return }
        if (pathname === '/' || pathname === '/compare' || pathname === '/trips' || pathname.startsWith('/address/')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return }
        if (/^\/smoke-sprite(@2x)?\.(json|png)$/.test(pathname)) {
            const png = pathname.endsWith('.png')
            res.writeHead(200, { 'Content-Type': png ? 'image/png' : 'application/json' })
            res.end(png ? Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') : '{}')
            return
        }
        if (pathname.startsWith('/assets/') && !pathname.includes('..')) {
            try {
                const type = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[extname(pathname)] ?? 'application/octet-stream'
                const body = await readFile(join(output, pathname))
                res.writeHead(200, { 'Content-Type': type }); res.end(body); return
            } catch { /* Explicit failure below, never fall back to a real backend. */ }
        }
        res.writeHead(501, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ message: 'Unexpected smoke server request; API must be intercepted by the test.' }))
    })
    server.on('error', async error => { console.error(error); await rm(output, { recursive: true, force: true }); process.exit(1) })
    server.listen(4173, '127.0.0.1', () => console.log('Compare smoke: http://127.0.0.1:4173 (no backend)'))
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { await rm(output, { recursive: true, force: true }); process.exit(0) }))
} catch (error) { await rm(output, { recursive: true, force: true }); throw error }
