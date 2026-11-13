import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule } from './support/vue-component.mjs'

const path = name => new URL(`../../resources/js/utils/${name}.ts`, import.meta.url)
const profilePresentation = loadModule(path('profilePresentation'))
const metricDisplay = loadModule(path('metricDisplay'))
const comparisonPresentation = loadModule(path('comparisonPresentation'), { './profilePresentation': profilePresentation })
const presentation = loadModule(path('homeMetricPresentation'), {
    './comparisonPresentation': comparisonPresentation, './profilePresentation': profilePresentation, './metricDisplay': metricDisplay,
})

const row = (category, key, label = key) => ({ category, key, label })
const metric = {
    key: 'nearest_distance', value: 740, unit: 'm', source: 'OSM', dataset_import_id: 42,
    observed_at: '2026-10-20', source_updated_at: '2026-10-21', calculated_at: '2026-10-22', method_version: 'v3',
    quality: { method: 'DERIVED', availability: 'AVAILABLE', freshness: 'STALE', reason: 'Слой покрывает не весь город.' },
}
const coverage = { status: 'PARTIAL', reason: 'Охват неполный.', radius_m: 500, available_radius_m: 500, buffer_m: 120, dataset_import_id: 42 }

test('explanations keep distance semantics and caveats specific to each real metric', () => {
    assert.match(presentation.metricExplanation(row('transport', 'nearest_stop_distance')).full, /официального набора остановок/)
    assert.match(presentation.metricExplanation(row('parks', 'nearest_distance', 'Парк')).short, /не подтверждает вход/)
    assert.match(presentation.metricExplanation(row('roads', 'nearest_distance')).full, /не измеряет шум или загрязнение/)
    assert.match(presentation.metricExplanation(row('parks', 'share')).full, /не складываются/)
    assert.doesNotMatch(presentation.metricExplanation(row('parks', 'nearest_distance')).full, /envNote/)
})

test('home metric presentation preserves partial coverage, nearest object and beyond-radius distinction', () => {
    const profile = { blocks: { parks: { status: 'READY', data: { coverage, nearest: { name: 'Центральный парк', access: 'private' }, metrics: { nearest_distance: metric } } } } }
    const result = presentation.homeMetricPresentation(profile, row('parks', 'nearest_distance'), 500)
    assert.equal(result.metric, metric)
    assert.equal(result.coverage, coverage)
    assert.equal(result.nearestName, 'Центральный парк')
    assert.equal(result.access, 'private')
    assert.equal(result.beyond, false, 'partial coverage cannot establish that the result lies beyond covered radius')
    const complete = { ...profile, blocks: { parks: { ...profile.blocks.parks, data: { ...profile.blocks.parks.data, coverage: { ...coverage, status: 'COVERED' } } } } }
    assert.equal(presentation.homeMetricPresentation(complete, row('parks', 'nearest_distance'), 500).beyond, true)
})

test('dialog detail presentation exposes all quality, provenance, dates and coverage fields', () => {
    assert.deepEqual(presentation.homeMetricDetails(metric, coverage), {
        reason: 'Слой покрывает не весь город.', method: 'Расчёт по данным', availability: 'Результат доступен', freshness: 'устаревшие',
        source: 'OSM', snapshot: 42, observationDate: '20.10.2026', publicationDate: '21.10.2026', calculationDate: '22.10.2026',
        methodVersion: 'v3', coverageStatus: 'PARTIAL', coverageRadius: 500, coverageBuffer: 120, coverageReason: 'Охват неполный.',
    })
})

test('null and zero remain distinct; unknown observation cannot be replaced by publication or calculation date', () => {
    const missing = { ...metric, value: null, observed_at: null, quality: { ...metric.quality, availability: 'INSUFFICIENT_DATA' } }
    assert.equal(metricDisplay.formatMetric(missing), 'Недостаточно данных')
    assert.equal(metricDisplay.formatMetric({ ...metric, value: 0 }), '0 м')
    assert.equal(presentation.homeMetricDetails(missing, { ...coverage, available_radius_m: null }).observationDate, 'неизвестна')
    assert.equal(presentation.homeMetricDetails(missing, { ...coverage, available_radius_m: null }).coverageRadius, 'неизвестен')
    assert.equal(presentation.homeMetricDetails(missing).publicationDate, '21.10.2026')
})

test('side states remain distinct and errors retain backend message', () => {
    assert.equal(presentation.homeMetricStateText('loading'), 'Загрузка данных…')
    assert.match(presentation.homeMetricStateText('not_found'), /не найден/)
    assert.match(presentation.homeMetricStateText('unavailable'), /временно недоступен/)
    assert.equal(presentation.homeMetricStateText('error', 'Backend detail'), 'Backend detail')
    assert.match(presentation.homeMetricStateText('empty'), /Выберите адрес/)
})
