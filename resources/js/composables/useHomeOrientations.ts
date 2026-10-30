import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { homeStandaloneTrip } from './useHomeTrips'
import { acceptedTrip } from '@/utils/comparisonTrips'
import { tripDuration } from '@/utils/trips'
import { formatMetric } from '@/utils/metricDisplay'
import { homeMetricStateText } from '@/utils/homeMetricPresentation'
import { compareOrientation, orientationScale, parseOrientation } from '@/utils/homeOrientation'
import type { HomeWorkspace } from './useHomeWorkspace'
import type { HomeTripsPort } from '@/types/homeWorkspace'
import type { HomeOrientationTarget, HomeOrientationGroup, HomeOrientationCell } from '@/types/homeOrientations'

export const orientationKey = (target: HomeOrientationTarget) => target.kind === 'stop' ? 'addresses:metric:transport:nearest_stop_distance'
    : JSON.stringify([target.scenario, target.placeId, target.mode])
const evaluated = (cell: HomeOrientationCell) => cell.result.value !== null && cell.result.status !== 'unavailable'

/** Session-only settings. Never writes to domain owners, requests, history or storage. */
export function useHomeOrientations(home: HomeWorkspace, trips: HomeTripsPort) {
    const settings = ref<Record<string, number>>({})
    const editing = ref<HomeOrientationTarget | null>(null)
    const highlighted = ref<string[]>([])
    const announcement = ref('')
    let baseline = new Map<string, string>()
    let timer: ReturnType<typeof setTimeout> | undefined
    let accented = new Map<string, string>()
    const fingerprint = (cell: HomeOrientationCell) => JSON.stringify([cell.result.status, cell.result.value, cell.result.threshold])
    const addressGoals = (): { id: string; identity: object }[] => trips.addresses.places.value.map(place => ({ id: place.id, identity: place }))
    const standaloneGoals = (): { id: string; identity: object }[] => trips.standalone.draft.places.map((place, index) => ({ id: homeStandaloneTrip(trips, index)!.placeId, identity: place }))
    // Reference changes delimit restored selections, even when a foreign link reuses an ID.
    for (const [scenario, goals] of [['addresses', addressGoals], ['standalone', standaloneGoals]] as const) {
        watch(() => goals(), (next, previous) => {
            for (const old of previous) if (!next.some(goal => goal.id === old.id && goal.identity === old.identity)) {
                for (const mode of ['driving', 'walking'] as const) delete settings.value[orientationKey({ kind: 'trip', scenario, placeId: old.id, mode })]
            }
        }, { flush: 'sync' })
    }
    function group(target: HomeOrientationTarget): HomeOrientationGroup | null {
        const key = orientationKey(target), threshold = settings.value[key] ?? null
        const samples: { side: HomeOrientationCell['side']; label: string; value: number | null; state: HomeOrientationCell['state']; reason: string; displayValue: string }[] = []
        let title: string, explanation: string
        const unit = target.kind === 'stop' ? 'meters' : 'minutes'
        if (target.kind === 'stop') {
            title = 'Ближайшая остановка'
            explanation = 'Личный ориентир прямого расстояния до официальной остановки. Это не время пешего подхода и не норматив доступности. Радиус окружения не задаёт ориентир.'
            for (const side of home.selectedSides.value) {
                const state = home.sides[side], block = state.profile?.blocks?.transport
                const metric = block?.status === 'READY' ? block.data.metrics.nearest_stop_distance : undefined
                const coverage = block?.status === 'READY' ? block.data.coverage : undefined
                // UNKNOWN freshness is an explicit limitation, not a fabricated observation date.
                let reason = state.status !== 'ready' ? homeMetricStateText(state.status)
                    : block?.status === 'ERROR' ? block.message : !metric ? 'Показатель недоступен.'
                    : metric.value === null || metric.quality.availability !== 'AVAILABLE' ? metric.quality.reason
                    : metric.unit !== 'm' || metric.quality.method !== 'DERIVED' ? 'Метод или единицы не позволяют сравнение прямого расстояния.'
                    : metric.quality.freshness === 'STALE' ? `Данные устарели: ${metric.quality.reason}`
                    : coverage?.status !== 'COVERED' ? coverage?.reason || 'Покрытие неизвестно.' : ''
                const value = reason ? null : metric?.value ?? null
                if (value !== null && (!Number.isFinite(value) || value < 0)) reason = 'Значение неизвестно.'
                samples.push({ side, label: side === 'left' ? 'А' : 'Б', value: reason ? null : value, reason, state: !reason ? 'ready' : state.status === 'loading' ? 'loading' : block?.status === 'ERROR' || state.status === 'error' || state.status === 'unavailable' ? 'error' : 'unknown',
                    displayValue: state.status === 'ready' && metric ? formatMetric(metric) : 'Нет оценки' })
            }
        } else {
            const place = target.scenario === 'addresses' ? trips.addresses.places.value.find(place => place.id === target.placeId)
                : trips.standalone.draft.places.find((_, index) => homeStandaloneTrip(trips, index)?.placeId === target.placeId)
            if (!place) return null
            title = place.label || 'Без названия'
            explanation = `${target.mode === 'walking' ? 'Модельное время уличной части.' : 'Модельное время без пробок и парковки.'} «В ориентире» — только отношение модели к вашему условию. Подходы, входы и пригодность жилья не подтверждены.`
            for (const side of target.scenario === 'addresses' ? home.selectedSides.value : ['start'] as const) {
                const index = trips.standalone.draft.places.indexOf(place as typeof trips.standalone.draft.places[number])
                const standalone = trips.standalone
                const isAddress = target.scenario === 'addresses'
                const cell = side !== 'start' ? trips.addresses.cells[side][target.placeId] : undefined
                const row = isAddress ? cell?.row ?? null : standalone.analysis.value?.results.find(row => row.index === index) ?? null
                const loading = isAddress ? cell?.status === 'loading' : standalone.status.value === 'loading' && (!standalone.pendingChoiceIndices.value.length || standalone.pendingChoiceIndices.value.includes(index))
                const failed = !isAddress && standalone.failedChoiceIndices.value.includes(index)
                const error = isAddress ? cell?.error ?? '' : failed || !row ? standalone.error.value : ''
                const pending = !isAddress && standalone.pendingChoiceIndices.value.includes(index)
                const mode = isAddress ? trips.addresses.mode.value : standalone.mode.value
                const reason = mode !== target.mode ? 'Для этого режима нужен расчёт.' : loading || pending ? 'Расчёт выполняется…' : error || (failed ? 'Расчёт этой поездки не получен.' : '')
                    || (!row ? 'Нужен расчёт этой поездки.' : !acceptedTrip(row) ? row.reason || 'Путь не подтверждён.' : '')
                samples.push({ side, label: side === 'start' ? 'Самостоятельный старт' : side === 'left' ? 'А' : 'Б',
                    value: reason || !acceptedTrip(row) ? null : row.route.duration_s, reason,
                    state: !reason ? 'ready' : loading || pending ? 'loading' : error || failed ? 'error' : mode !== target.mode || !row ? 'need' : row.status === 'NEEDS_REFINEMENT' ? 'refinement' : 'unknown',
                    displayValue: !reason && acceptedTrip(row) ? tripDuration(row.route.duration_s) : 'Нет оценки' })
            }
        }
        const results = samples.map(sample => compareOrientation(sample.value, threshold, unit, sample.reason || undefined))
        const scale = orientationScale(results, unit)
        return { key, target, title, unit, threshold, thresholdPercent: scale.thresholdPercent, explanation,
            cells: samples.map((sample, index) => ({ ...sample, key: JSON.stringify([key, sample.side]), result: results[index]!, percent: scale.values[index]! })) }
    }
    // The single prepared source for table, live dialog and future G4.3 map signals.
    const groups = computed(() => [
        ...addressGoals().map(goal => group({ kind: 'trip', scenario: 'addresses', placeId: goal.id, mode: trips.addresses.mode.value })),
        ...standaloneGoals().map(goal => group({ kind: 'trip', scenario: 'standalone', placeId: goal.id, mode: trips.standalone.mode.value })),
        group({ kind: 'stop' }),
    ].filter((value): value is HomeOrientationGroup => value !== null))
    watch(groups, values => {
        const current = new Map(values.flatMap(group => group.cells).map(cell => [cell.key, fingerprint(cell)]))
        highlighted.value = highlighted.value.filter(key => current.get(key) === accented.get(key))
    }, { flush: 'sync' })
    function find(target: HomeOrientationTarget) { return groups.value.find(group => group.key === orientationKey(target)) ?? null }
    const current = computed(() => editing.value ? find(editing.value) : null)
    function begin(target: HomeOrientationTarget) {
        clearTimeout(timer); highlighted.value = []; accented.clear(); announcement.value = ''
        editing.value = target
        baseline = new Map((find(target)?.cells ?? []).filter(evaluated).map(cell => [cell.key, cell.result.status]))
    }
    function apply(text: string) {
        const parsed = parseOrientation(text)
        if (parsed.error || !editing.value) return parsed.error
        const key = orientationKey(editing.value)
        if (parsed.value === null) delete settings.value[key]
        else settings.value[key] = parsed.value
        return ''
    }
    function finish() {
        const changed = (current.value?.cells ?? []).filter(cell => evaluated(cell) && baseline.has(cell.key) && baseline.get(cell.key) !== cell.result.status)
        accented = new Map(changed.map(cell => [cell.key, fingerprint(cell)]))
        highlighted.value = changed.map(cell => cell.key)
        announcement.value = changed.length ? `${current.value!.title}. ${changed.map(cell => `${cell.label}: ${cell.result.text}`).join('; ')}.` : ''
        editing.value = null; baseline.clear()
        if (changed.length) timer = setTimeout(() => { highlighted.value = [] }, 6500)
    }
    onBeforeUnmount(() => clearTimeout(timer))
    return { groups, current, editing, highlighted, announcement, find, begin, apply, finish }
}
