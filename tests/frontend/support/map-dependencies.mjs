import * as vue from 'vue'
import { loadModule } from './vue-component.mjs'

const utility = path => loadModule(new URL('../../../resources/js/' + path, import.meta.url))
export const themeUtils = utility('utils/mapTheme.ts')
export const labelUtils = utility('utils/mapLabels.ts')
const presentation = utility('utils/mapLayerPresentation.ts')
const analysis = utility('utils/mapAnalysis.ts')
const candidates = utility('utils/tripCandidates.ts')
const trips = loadModule(new URL('../../../resources/js/utils/tripMap.ts', import.meta.url), { '@/utils/tripCandidates': candidates })
const overlay = loadModule(new URL('../../../resources/js/utils/tripOverlay.ts', import.meta.url), { '@/utils/tripMap': trips })
const sidebar = utility('utils/mapSidebarScroll.ts')
// Pure modules are real; lifecycle/storage are isolated by these component tests.
// Chromium covers the complete integration with MapLibre and browser globals.
export const mapDependencies = {
    ...themeUtils, ...labelUtils, ...presentation, ...analysis,
    useMapTheme: () => ({ theme: vue.ref('light'), setTheme() {} }),
    MapThemeControl: { render: () => vue.h('div') },
    AddressMapLabels: { render: () => vue.h('div') },
}
