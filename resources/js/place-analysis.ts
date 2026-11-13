export type AnalysisTab = 'overview' | 'objects' | 'satellite' | 'air'
export type AnalysisLayer = 'objects' | 'satellite' | 'stations' | 'radius'
export type SatelliteMode = 'snapshot' | 'ndvi'
export type { AnalysisPoint, PoiCategory } from '@/types/placeAnalysis'
import type { AnalysisPoint, PoiCategory } from '@/types/placeAnalysis'
export interface PlaceSelection extends AnalysisPoint { id: string | null; label: string }

export const categoryOrder: PoiCategory[] = ['grocery', 'pharmacy', 'official_stop', 'park']

export const categoryMeta: Record<PoiCategory, { label: string; color: string }> = {
    grocery: { label: 'Продукты', color: '#7c3aed' },
    pharmacy: { label: 'Аптеки', color: '#2f855a' },
    official_stop: { label: 'Остановки', color: '#2b6cb0' },
    park: { label: 'Парки', color: '#4d7c0f' },
}
