<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, useId } from 'vue'
import MapLayerDetails from './MapLayerDetails.vue'
import { mapLayerDefinitions, mapLayerNotice } from '@/utils/mapLayerPresentation'
import type { AreaVisibility, LinearVisibility } from '@/types/profile'
import type { MapLayerContext, MapLayerKey } from '@/types/mapLayers'

const props = defineProps<{ stops: boolean; areas: AreaVisibility; lines: LinearVisibility; contexts: MapLayerContext[]; comparison?: boolean; singleMap?: boolean; compact?: boolean; floating?: boolean }>()
const emit = defineEmits<{
    'update:stops': [value: boolean]
    'update:areas': [value: AreaVisibility]
    'update:lines': [value: LinearVisibility]
    focusLayer: [key: MapLayerKey]
}>()
const id = useId()
const expanded = ref(false)
const root = ref<HTMLElement | null>(null)
const toggle = ref<HTMLButtonElement | null>(null)
const groups = computed(() => props.floating ? [mapLayerDefinitions.filter(layer => ['stops', 'parks'].includes(layer.key)), mapLayerDefinitions.filter(layer => !['stops', 'parks'].includes(layer.key))] : [mapLayerDefinitions])
function outside(event: PointerEvent) { if (props.floating && root.value && !root.value.contains(event.target as Node)) expanded.value = false }
onMounted(() => { if (props.floating) document.addEventListener('pointerdown', outside) })
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside))
function wheel(event: WheelEvent) {
    if (!props.floating) return
    event.stopPropagation()
    if (event.ctrlKey || event.metaKey) event.preventDefault()
}
function focusLayer(key: MapLayerKey) {
    if (props.floating) expanded.value = false
    emit('focusLayer', key)
}
function escape() {
    if (info.value) { void closeInfo(); return }
    if (props.floating) { expanded.value = false; toggle.value?.focus({ preventScroll: true }) }
}
const info = ref<MapLayerKey | null>(null)
onMounted(() => { expanded.value = !props.floating && !props.compact && window.matchMedia('(min-width: 768px)').matches })
function enabled(key: MapLayerKey) {
    return key === 'stops' ? props.stops : key === 'roads' || key === 'railways' ? props.lines[key] : props.areas[key]
}
const active = computed(() => mapLayerDefinitions.filter(layer => enabled(layer.key)))
function change(key: MapLayerKey, event: Event) {
    const value = (event.target as HTMLInputElement).checked
    if (key === 'stops') emit('update:stops', value)
    else if (key === 'roads' || key === 'railways') emit('update:lines', { ...props.lines, [key]: value })
    else emit('update:areas', { ...props.areas, [key]: value })
}
async function closeInfo() {
    const key = info.value
    info.value = null
    await nextTick()
    if (key) document.getElementById(`${id}-${key}-info-button`)?.focus()
}
</script>

<template>
    <section ref="root" class="map-layers-panel" :class="{ 'map-layers-panel--floating': floating }" @wheel="wheel" :aria-label="comparison ? (singleMap ? 'Слои вариантов А и Б' : 'Слои обеих карт') : 'Слои карты'" @keydown.esc.stop.prevent="escape">
        <button ref="toggle" type="button" class="map-layers-toggle" :aria-expanded="expanded" :aria-controls="`${id}-layers`" @click="expanded = !expanded">
            <span class="map-layers-toggle-title"><span aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span> Слои <span class="map-layers-count">{{ active.length }}<span :class="{ 'map-layers-count-label': floating }"> включено</span></span></span>
            <span v-if="!expanded && !floating" class="map-layers-active">
                <span v-if="!active.length" class="map-layers-empty">Все дополнительные слои выключены</span>
                <span v-for="layer in active" :key="layer.key" class="map-layer-chip">
                    <span class="layer-symbol" :class="`layer-symbol--${layer.symbol}`" :style="{ '--layer-color': layer.color }" aria-hidden="true" />{{ layer.label }}
                </span>
            </span>
            <span class="map-layers-toggle-action">{{ expanded ? 'Скрыть' : 'Показать' }}</span>
        </button>
        <div v-show="expanded" :id="`${id}-layers`" class="map-layers-body">
            <p v-if="comparison" class="map-layers-shared">Переключатели общие для А и Б. Данные каждого варианта указаны отдельно.</p>
            <template v-for="(group, index) in groups" :key="index">
                <component :is="index ? 'details' : 'div'" class="map-layer-group">
                    <summary v-if="index" class="map-layers-additional">Дополнительные</summary>
                    <div class="map-layer-rows">
                        <div v-for="layer in group" :key="layer.key" class="map-layer-row">
                            <div class="map-layer-row-controls">
                                <label>
                                    <input type="checkbox" :checked="enabled(layer.key)" @change="change(layer.key, $event)" />
                                    <span class="layer-symbol" :class="`layer-symbol--${layer.symbol}`" :style="{ '--layer-color': layer.color }" aria-hidden="true" />
                                    <span>{{ floating && layer.key === 'stops' ? 'Остановки' : layer.label }}</span>
                                </label>
                                <button type="button" class="map-layer-info-button" :aria-label="`Показать слой: ${layer.label}`" @click="focusLayer(layer.key)">На карте</button>
                                <button :id="`${id}-${layer.key}-info-button`" type="button" class="map-layer-info-button" :aria-label="`О данных: ${layer.label}`" :aria-expanded="info === layer.key" :aria-controls="`${id}-${layer.key}-data`" @click="info = info === layer.key ? null : layer.key">О данных</button>
                            </div>
                            <div v-if="enabled(layer.key)" class="map-layer-notices" aria-live="polite">
                                <template v-for="context in contexts" :key="context.key">
                                    <p v-if="mapLayerNotice(layer.key, context)"><span v-if="comparison">{{ context.label }}: </span>{{ mapLayerNotice(layer.key, context) }}</p>
                                </template>
                            </div>
                            <div v-show="info === layer.key" :id="`${id}-${layer.key}-data`" class="map-layer-data">
                                <template v-if="info === layer.key">
                                    <MapLayerDetails v-for="context in contexts" :key="context.key" :layer="layer.key" :context="context" :enabled="enabled(layer.key)" />
                                    <button type="button" class="result-action" @click="closeInfo">Закрыть сведения</button>
                                </template>
                            </div>
                        </div>
                </div>
                </component>
            </template>
            <p class="map-layers-footnote">Дополнительные слои в области анализа. Тема подложки меняется отдельно и не меняет анализ. Пустой результат не доказывает отсутствие объектов на местности.</p>
        </div>
    </section>
</template>
