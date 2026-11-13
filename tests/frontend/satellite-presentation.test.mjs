import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule } from './support/vue-component.mjs'
import { satelliteDataFor, satelliteLegend } from './fixtures/place-analysis.mjs'

const presentation = loadModule(new URL('../../resources/js/utils/satellite.ts', import.meta.url))

test('date and circle fractions are presentation-only and never re-derive coverage', () => {
    assert.equal(presentation.formatObservationDate('2024-05-07'), '07.05.2024')
    assert.equal(presentation.formatObservationDate(null), '—')
    assert.equal(presentation.formatObservationDate('bad'), '—')
    assert.match(presentation.formatCircleFraction(.875), /^87,5\s%$/u)
    assert.match(presentation.formatCircleFraction(1), /^100\s%$/u)
    assert.equal(presentation.formatMeanNdvi(0), '0,00')
    assert.equal(presentation.formatMeanNdvi(null), '—')
})

test('selected observation wording stays distinct from a catalog and from low NDVI', () => {
    const data = satelliteDataFor('2024-05-07')
    assert.equal(presentation.satelliteLayerLabel('ndvi', data), 'NDVI (Sentinel-2) · 07.05.2024')
    assert.equal(presentation.satelliteLayerLabel('snapshot', data), 'Спутниковый снимок · 07.05.2024')
    assert.equal(presentation.satelliteLayerLabel('ndvi', null), 'NDVI (Sentinel-2)')
    assert.equal(presentation.satelliteCatalogLabel(data), 'Доступно дат: 2')
    assert.equal(presentation.satelliteCatalogLabel({ ...data, available_dates: [] }), 'Пригодных дат нет')
    assert.equal(presentation.satelliteReasonLabel('DATE_NOT_SELECTED'), 'Дата не выбрана')
    assert.equal(presentation.satelliteReasonLabel('NO_USABLE_NDVI'), 'Нет пригодных пикселей NDVI')
    assert.equal(presentation.satelliteReasonLabel(null), 'Данные недоступны')
    assert.deepEqual(presentation.satelliteWarnings(data.selected).map(warning => warning.code), ['EARLY_SPRING_SNOW'])
    assert.equal(satelliteLegend.unknown.label, 'Неизвестно / исключено маской')
})

test('coverage reasons show only nonzero exclusions and never turn unknowns into low NDVI', () => {
    const data = satelliteDataFor('2024-05-07')
    const reasons = presentation.coverageReasons(data.selected.coverage)
    assert.deepEqual(reasons.map(reason => reason.key), ['nodata'])
    assert.equal(reasons[0].count, 200)
    const empty = presentation.coverageReasons({ ...data.selected.coverage, reason_counts: { valid: 1600, nodata: 0, snow: 0 } })
    assert.deepEqual(empty, [])
    assert.deepEqual(presentation.coverageReasons(null), [])
})
