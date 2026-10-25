import { defineConfig } from '@playwright/test'

export default defineConfig({
    testDir: './tests/browser',
    testMatch: '*.spec.mjs',
    fullyParallel: false,
    workers: 1,
    retries: 0,
    forbidOnly: !!process.env.CI,
    timeout: 30_000,
    expect: { timeout: 7_000 },
    outputDir: 'test-results/compare-smoke',
    reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
    use: {
        baseURL: 'http://127.0.0.1:4173',
        browserName: 'chromium',
        serviceWorkers: 'block',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
    },
    projects: [
        { name: 'phone-320', use: { viewport: { width: 320, height: 740 } } },
        { name: 'phone-390', use: { viewport: { width: 390, height: 844 } } },
        { name: 'short-desktop', use: { viewport: { width: 1280, height: 720 } } },
        { name: 'very-short-desktop', use: { viewport: { width: 1280, height: 560 } } },
    ],
    webServer: {
        command: 'node tests/browser/server.mjs',
        url: 'http://127.0.0.1:4173/compare',
        reuseExistingServer: false,
        timeout: 30_000,
    },
})
