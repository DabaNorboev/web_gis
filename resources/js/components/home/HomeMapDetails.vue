<script setup lang="ts">
import { homeDialogKey } from '@/utils/homeDialog'
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import HomeTripCell from './HomeTripCell.vue'
import type { HomeTripActions, HomeTripEntry } from '@/types/homeResults'
import type { HomeTripRef } from '@/types/homeWorkspace'
import type { TripMode } from '@/types/trips'
const props = defineProps<{ entry: HomeTripEntry | null; alternatives: HomeTripEntry[]; goalNumber: number; actions: HomeTripActions; mode: TripMode; request: number }>()
const emit = defineEmits<{ close: []; returnRow: []; select: [trip: HomeTripRef] }>()
const dialog = ref<HTMLDialogElement | null>(null)
let restoreFocus = true
function close(restore = true) { restoreFocus = restore; dialog.value?.close() }
watch(() => props.request, async () => { await nextTick(); if (props.entry && !dialog.value?.open) { restoreFocus = true; dialog.value?.showModal() } })
watch(() => props.entry, entry => { if (!entry) dialog.value?.close() })
onBeforeUnmount(() => dialog.value?.close())
const actions: HomeTripActions = {
    ...props.actions,
    show: trip => { close(false); props.actions.show(trip) },
    pickStreet: (trip, end) => { close(false); props.actions.pickStreet(trip, end) },
    act: (trip, action, location) => { close(false); props.actions.act(trip, action, location) },
}
</script>
<template>
    <Teleport to="#main-content" defer>
    <dialog @keydown="homeDialogKey" ref="dialog" class="home-result-dialog home-map-details" aria-label="Результат на карте" @close="restoreFocus && emit('close')">
        <template v-if="entry">
            <header><h2>Цель {{ goalNumber }} · {{ entry.title }}</h2><button type="button" autofocus @click="close()">Закрыть</button></header>
            <nav aria-label="Сторона поездки"><button v-for="alternative in alternatives" :key="JSON.stringify(alternative.trip)" type="button" :aria-pressed="JSON.stringify(alternative.trip) === JSON.stringify(entry.trip)" @click="emit('select', alternative.trip)">Поездка {{ alternative.trip.scenario === 'addresses' ? alternative.trip.side === 'left' ? 'А' : 'Б' : 'от старта' }}</button></nav>
            <p>Исходные объекты и выбранные уличные точки различаются. Подходы и входы не подтверждены.</p>
            <HomeTripCell :entry="entry" :actions="actions" :mode="mode" />
            <button type="button" @click="close(false); emit('returnRow')">К строке</button>
        </template>
    </dialog>
    </Teleport>
</template>
