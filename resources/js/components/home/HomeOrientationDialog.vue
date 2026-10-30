<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import HomeOrientationStatus from './HomeOrientationStatus.vue'
import type { HomeOrientationTarget } from '@/types/homeOrientations'
import type { useHomeOrientations } from '@/composables/useHomeOrientations'
const props = defineProps<{ owner: ReturnType<typeof useHomeOrientations> }>()
const dialog = ref<HTMLDialogElement | null>(null)
const field = ref<HTMLInputElement | null>(null)
const input = ref(''), error = ref('')
let trigger: HTMLElement | null = null
let active = false
async function open(target: HomeOrientationTarget, initiator: HTMLElement) {
    trigger = initiator; active = true
    props.owner.begin(target)
    input.value = props.owner.current.value?.threshold?.toString() ?? ''; error.value = ''
    await nextTick()
    dialog.value?.showModal(); field.value?.focus({ preventScroll: true }); field.value?.scrollIntoView({ block: 'nearest' })
}
function update(value: string) { input.value = value; error.value = props.owner.apply(value) }
function close() { dialog.value?.close(); void closed() }
async function closed() {
    if (!active || dialog.value?.open) return
    active = false
    const initiator = trigger; trigger = null
    props.owner.finish()
    await nextTick()
    if (!active && initiator?.isConnected) initiator.focus({ preventScroll: true })
}
watch(props.owner.current, value => { if (!value && dialog.value?.open) close() })
defineExpose({ open })
</script>
<template>
    <dialog ref="dialog" class="home-result-dialog home-orientation-dialog" aria-labelledby="home-orientation-title" @close="closed" @cancel.prevent="close" @click="event => { if (event.target === dialog) close() }">
        <template v-if="owner.current.value">
            <header><h2 id="home-orientation-title">Личный ориентир · {{ owner.current.value.title }}</h2><button type="button" @click="close">Закрыть</button></header>
            <div class="home-orientation-body">
                <p>{{ owner.current.value.explanation }}</p>
                <p v-if="owner.current.value.target.kind === 'trip'">{{ owner.current.value.target.mode === 'walking' ? 'Пешком' : 'Автомобиль' }} · общий ориентир для сторон этой цели.</p>
                <label for="home-orientation-value">{{ owner.current.value.unit === 'minutes' ? 'Модельное время, минуты' : 'Прямое расстояние, метры' }}</label>
                <input id="home-orientation-value" ref="field" type="text" inputmode="decimal" autocomplete="off" :value="input" :aria-invalid="!!error" aria-describedby="home-orientation-error home-orientation-hint" @input="update(($event.target as HTMLInputElement).value)" />
                <p id="home-orientation-error" class="home-orientation-error" :role="error ? 'alert' : undefined">{{ error }}</p>
                <p id="home-orientation-hint">Правка применяется сразу. Пустое поле снимает ориентир; ошибка сохраняет последнее корректное значение.</p>
                <button type="button" @click="update(''); field?.focus()">Снять ориентир</button>
                <section class="home-orientation-preview" aria-label="Живая сводка">
                    <h3>Сейчас по этому ориентиру</h3>
                    <p v-if="!owner.current.value.cells.length">Выберите старт, чтобы получить оценку.</p>
                    <article v-for="cell in owner.current.value.cells" :key="cell.key">
                        <strong>{{ cell.label }} · {{ cell.displayValue }}</strong>
                        <HomeOrientationStatus :group="owner.current.value" :cell="cell" />
                        <p v-if="cell.reason">{{ cell.reason }}</p>
                        <p v-if="owner.current.value.threshold === null">Ориентир не задан.</p>
                    </article>
                </section>
                <p>Правка применяется к готовым и приходящим результатам. Исходные числа сохраняются.</p>
            </div>
            <footer><p class="home-orientation-storage">Ориентиры действуют в этом сеансе и не входят в ссылку</p><button type="button" @click="close">Готово</button></footer>
        </template>
    </dialog>
</template>
