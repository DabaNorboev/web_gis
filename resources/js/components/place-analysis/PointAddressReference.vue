<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { distinguishAddressLabels, localAddressLabel, localAddressType } from '@/utils/addressLabels'
import type { PointAddressCandidate } from '@/types/pointAddress'

const props = defineProps<{
    candidates: PointAddressCandidate[]
    status: 'idle' | 'loading' | 'ready' | 'error'
    transitionPending: boolean
    transitionError: boolean
}>()
const emit = defineEmits<{ analyze: [id: string]; retry: [] }>()
const labels = computed(() => distinguishAddressLabels(
    props.candidates.map(c => localAddressLabel(c.label, c.display)),
    props.candidates.map(c => localAddressType[c.object_type]),
))
const chosenId = ref('')
watch(() => props.candidates, () => { chosenId.value = '' })
const addressId = computed(() => props.candidates.length === 1 ? props.candidates[0]!.id : chosenId.value)
</script>

<template>
    <section class="pa-point-reference" aria-label="Адрес-ориентир выбранной точки" :aria-busy="status === 'loading' || transitionPending">
        <p v-if="candidates.length === 1"><strong>Ближайший адрес: </strong>{{ labels[0] }}</p>
        <select v-else-if="candidates.length > 1" v-model="chosenId" class="pa-point-reference__select"
            aria-label="Ближайший адрес" :disabled="transitionPending">
            <option value="" disabled>Выберите ближайший адрес</option>
            <option v-for="(candidate, index) in candidates" :key="candidate.id" :value="candidate.id">{{ labels[index] }}</option>
        </select>
        <p v-else-if="status === 'loading'" class="pa-note" role="status">Ищем адрес…</p>
        <p v-else-if="status === 'error'" class="pa-note" role="status">Адрес-ориентир недоступен.</p>
        <p v-else-if="!$slots.point" class="pa-note">Точка на карте</p>
        <p v-if="transitionError" class="pa-note" role="status">Не удалось получить адрес.</p>
        <div v-if="$slots.point || candidates.length || status === 'error'" class="pa-point-actions">
            <slot name="point" />
            <button v-if="candidates.length" class="pa-outline" type="button" :disabled="!addressId || transitionPending"
                @click="emit('analyze', addressId)">{{ transitionPending ? 'Получаем адрес…' : 'Анализировать адрес' }}</button>
            <button v-else-if="status === 'error' && !$slots.point" class="pa-outline" type="button" @click="emit('retry')">Повторить поиск адреса</button>
        </div>
    </section>
</template>
