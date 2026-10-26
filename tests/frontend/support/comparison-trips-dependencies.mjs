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
export const WalkingTripDetails = loadComponent(new URL('../../../resources/js/components/WalkingTripDetails.vue', import.meta.url), { '@/utils/trips': tripUtils })
export const ComparisonTrips = loadComponent(new URL('../../../resources/js/components/ComparisonTrips.vue', import.meta.url), {
    '@/components/TripPointPicker.vue': { default: { render: () => null } },
    '@/utils/comparisonTrips': personalUtils, '@/utils/tripFailure': failure, '@/utils/trips': tripUtils, '@/utils/tripCandidates': candidateUtils,
    '@/components/WalkingTripDetails.vue': WalkingTripDetails,
})

export const ComparisonShare = loadComponent(new URL('../../../resources/js/components/ComparisonShare.vue', import.meta.url))
export const ComparisonTripData = loadComponent(new URL('../../../resources/js/components/ComparisonTripData.vue', import.meta.url), { '@/utils/trips': tripUtils, '@/components/WalkingTripDetails.vue': WalkingTripDetails })
