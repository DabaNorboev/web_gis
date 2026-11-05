<script setup lang="ts">
import type { PointAddressCandidate } from '@/types/pointAddress'

defineProps<{
    candidates: PointAddressCandidate[]
    status: 'idle' | 'loading' | 'ready' | 'error'
    transitionPending: boolean
    transitionError: boolean
    coverageReason?: string
    compact?: boolean
}>()
const emit = defineEmits<{ analyze: [id: string]; retry: [] }>()
function distance(value: number) {
    return value > 0 && value < 1 ? 'менее 1 м' : `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value)} м`
}
</script>

<template>
    <section class="pa-point-reference" aria-label="Адрес-ориентир выбранной точки" :aria-busy="status === 'loading' || transitionPending">
        <p v-if="!candidates.length" class="pa-note" role="status">Точка на карте<span v-if="status === 'loading'"> · ищем адрес-ориентир…</span></p>
        <p v-if="candidates.length > 1" class="pa-note">Несколько ближайших адресов в локальном наборе: разница расстояний не более 1 м. Выберите конкретный объект.</p>
        <div v-for="candidate in candidates" :key="candidate.id" class="pa-point-reference__candidate">
            <p><strong>{{ candidates.length === 1 ? 'Ближайший адрес: ' : 'Адрес-ориентир: ' }}</strong>{{ candidate.label }}</p>
            <p v-if="!compact" class="pa-note">{{ distance(candidate.distance_m) }} по прямой до {{ candidate.geometry_type === 'POINT' ? 'адресной точки' : 'контура' }}.</p>
            <button class="pa-outline" type="button" :disabled="transitionPending" @click="emit('analyze', candidate.id)">{{ transitionPending ? 'Получаем адрес…' : 'Анализировать этот адрес' }}</button>
        </div>
        <template v-if="candidates.length && !compact">
            <p class="pa-note">По доступным объектам локального OSM-набора, поиск в пределах 100 м. Полнота не гарантируется.</p>
            <p class="pa-note">Это ориентир, а не адрес выбранной точки. Координаты анализа не меняются; принадлежность адресу, вход и доступ не подтверждены.</p>
            <p v-if="coverageReason" class="pa-note">{{ coverageReason }}</p>
        </template>
        <p v-if="transitionError" class="pa-note" role="status">Не удалось получить адрес. Анализ выбранной точки сохранён.</p>
        <template v-if="status === 'error'">
            <p class="pa-note">Адрес-ориентир недоступен. Выбранную точку можно анализировать.</p>
            <button class="pa-outline" type="button" @click="emit('retry')">Повторить поиск адреса</button>
        </template>
    </section>
</template>
