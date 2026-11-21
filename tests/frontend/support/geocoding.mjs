import { loadModule } from './vue-component.mjs'
export const geocodingModule = errors => loadModule(new URL('../../../resources/js/api/geocoding.ts', import.meta.url), { './errors': errors })
