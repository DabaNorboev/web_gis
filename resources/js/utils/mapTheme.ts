import type { Map, StyleSpecification } from 'maplibre-gl'

export const mapThemes = [
    { key: 'light', label: 'Светлая' },
    { key: 'streets', label: 'Улицы' },
    { key: 'dark', label: 'Тёмная' },
] as const
export type MapTheme = typeof mapThemes[number]['key']
export const mapThemeStorageKey = 'placelens:map-theme:v1'
export function parseMapTheme(value: unknown): MapTheme {
    return mapThemes.some(theme => theme.key === value) ? value as MapTheme : 'light'
}

// Local cartographic variants of the existing licensed OpenMapTiles style.
// Sources, geometry, fonts, sprites, filters and Russian label fallback stay intact.
export function themedBasemap(base: StyleSpecification, theme: MapTheme): StyleSpecification {
    const style = structuredClone(base)
    if (theme === 'streets') return style
    const dark = theme === 'dark'
    const palette = dark
        ? { ground: '#202832', land: '#252f38', green: '#293d38', water: '#213e51', building: '#3c4651', edge: '#535f6c', road: '#56616f', casing: '#28323c', major: '#697580', text: '#cbd4dc', muted: '#9eacb9', halo: '#202832' }
        : { ground: '#f5f6f3', land: '#f0f2ee', green: '#e5ece4', water: '#dceaf0', building: '#e0e4e2', edge: '#cbd1d0', road: '#ffffff', casing: '#dce0dd', major: '#e1ded2', text: '#52616a', muted: '#74828a', halo: '#f7f8f5' }
    for (const layer of style.layers) {
        const sourceLayer = 'source-layer' in layer ? layer['source-layer'] : ''
        if (layer.type === 'background') layer.paint = { ...layer.paint, 'background-color': palette.ground }
        if (layer.type === 'fill') {
            const color = sourceLayer === 'water' ? palette.water : sourceLayer === 'building' ? palette.building : ['landcover', 'park'].includes(sourceLayer ?? '') ? palette.green : palette.land
            layer.paint = { ...layer.paint, 'fill-color': color, 'fill-outline-color': sourceLayer === 'building' ? palette.edge : color }
            delete layer.paint['fill-pattern']
        }
        if (layer.type === 'line') {
            const color = sourceLayer === 'waterway' ? palette.water : sourceLayer === 'transportation' ? /casing|hatching/.test(layer.id) ? palette.casing : /primary|secondary|trunk|motorway/.test(layer.id) ? palette.major : palette.road : palette.edge
            layer.paint = { ...layer.paint, 'line-color': color }
        }
        if (layer.type === 'symbol') {
            layer.paint = { ...layer.paint, 'text-color': sourceLayer === 'place' ? palette.text : palette.muted, 'text-halo-color': palette.halo }
            // Keep orientation labels; subdue POIs instead of competing with analysis.
            if (sourceLayer === 'poi') layer.paint['icon-opacity'] = dark ? 0.45 : 0.5
        }
    }
    return style
}

// Change paint on the same map: no setStyle, source replacement, fitBounds or API.
export function applyBasemapTheme(map: Pick<Map, 'getLayer' | 'setPaintProperty'>, base: StyleSpecification, theme: MapTheme) {
    const next = themedBasemap(base, theme)
    for (const layer of next.layers) {
        if (!map.getLayer(layer.id)) continue
        const original = base.layers.find(original => original.id === layer.id)
        const paint = layer.paint as Record<string, unknown> | undefined
        const themeKeys = layer.type === 'fill' ? ['fill-color', 'fill-outline-color', 'fill-pattern'] : layer.type === 'symbol' ? ['text-color', 'text-halo-color', ...('source-layer' in layer && layer['source-layer'] === 'poi' ? ['icon-opacity'] : [])] : layer.type === 'line' ? ['line-color'] : layer.type === 'background' ? ['background-color'] : []
        const keys = new Set([...Object.keys(original?.paint ?? {}), ...Object.keys(paint ?? {}), ...themeKeys])
        for (const property of keys) map.setPaintProperty(layer.id, property as Parameters<Map['setPaintProperty']>[1], paint?.[property] as Parameters<Map['setPaintProperty']>[2])
    }
}

export const placeColors = { default: '#2d6450', А: '#283e62', Б: '#8b3f57' } as const
