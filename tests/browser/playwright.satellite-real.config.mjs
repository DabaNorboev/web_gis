import { defineConfig } from '@playwright/test'

// Opt-in real-API browser check. Start the accepted A10.2 test HTTP process
// first (see docs/testing.md) and point the stand at it through the default
// service name or SATELLITE_TEST_API. This config is not part of npm test:smoke.
export default defineConfig({
    testDir: '.',
    testMatch: 'place-analysis-satellite-real.real.mjs',
    fullyParallel: false,
    workers: 1,
    retries: 1,
    timeout: 90_000,
    expect: { timeout: 20_000 },
    outputDir: 'test-results/satellite-real',
    reporter: [['list']],
    use: {
        baseURL: 'http://127.0.0.1:4180',
        browserName: 'chromium',
        serviceWorkers: 'block',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
    },
    projects: [
        { name: 'real-desktop', use: { viewport: { width: 1440, height: 900 } } },
        { name: 'real-short', use: { viewport: { width: 1280, height: 720 } } },
        { name: 'real-mobile', use: { viewport: { width: 390, height: 844 } } },
    ],
    webServer: {
        command: 'node real-satellite-server.mjs',
        url: 'http://127.0.0.1:4180/',
        reuseExistingServer: false,
        timeout: 60_000,
        stdout: 'pipe',
    },
})
