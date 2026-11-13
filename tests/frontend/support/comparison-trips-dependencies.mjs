import { readFileSync } from 'node:fs'
import { evaluateModule, loadComponent } from './vue-component.mjs'
const source = path => readFileSync(new URL('../../../resources/js/' + path, import.meta.url), 'utf8')
export const tripUtils = evaluateModule(source('utils/trips.ts'))
export const personalUtils = evaluateModule(source('utils/comparisonTrips.ts'), { '@/utils/trips': tripUtils })
export const failure = evaluateModule(source('utils/tripFailure.ts'))
export const candidateUtils = evaluateModule(source('utils/tripCandidates.ts'))
export function stateModule(fetchTrips, vueOverride) {
    return evaluateModule(source('composables/useComparisonTrips.ts'), {
        '@/utils/trips': tripUtils, '@/api/trips': { fetchTrips }, ...(vueOverride ? { vue: vueOverride } : {}),
    })
}
export const personalState = stateModule(() => { throw new Error('Unexpected route calculation in SSR') })
