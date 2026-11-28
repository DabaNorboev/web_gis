export async function openMapSettings(page) {
    const toggle = page.locator('.pa-map-settings-toggle')
    if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') === 'false') {
        await toggle.click()
    }
}

export async function openMapLayers(page) {
    await openMapSettings(page)
    const toggle = page.locator('.pa-map-layers-toggle')
    if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') === 'false') {
        await toggle.click()
    }
}
