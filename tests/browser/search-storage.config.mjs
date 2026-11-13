import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
const root = fileURLToPath(new URL('../../', import.meta.url))
export default defineConfig({
    testDir: '.', testMatch: 'search-storage.browser.mjs', workers: 1, fullyParallel: false, retries: 0, timeout: 30_000,
    outputDir: resolve(root, process.env.STORAGE_TEST_OUTPUT ?? 'test-results/search-storage'), reporter: [['list']],
    use: { baseURL: 'http://127.0.0.1:4178', browserName: 'chromium', serviceWorkers: 'block',
        launchOptions: process.env.STORAGE_CHROMIUM ? { executablePath: process.env.STORAGE_CHROMIUM, args: ['--no-sandbox'] } : {} },
    webServer: { cwd: root, command: 'node tests/browser/storage/server.mjs', url: 'http://127.0.0.1:4178', reuseExistingServer: false, timeout: 30_000 },
})
