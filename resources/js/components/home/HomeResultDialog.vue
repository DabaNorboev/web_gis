<script setup lang="ts">
import { ref, useId } from 'vue'
defineProps<{ title: string; label: string }>()
const dialog = ref<HTMLDialogElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const titleId = useId()
let returnFocus = true
function open() { returnFocus = true; dialog.value?.showModal() }
function close(restore = true) { returnFocus = restore; dialog.value?.close() }
</script>
<template>
    <button ref="trigger" type="button" class="home-cell-info" :aria-label="label" @click="open">ⓘ</button>
    <dialog ref="dialog" class="home-result-dialog" :aria-labelledby="titleId" @close="returnFocus && trigger?.focus({ preventScroll: true })" @click="event => { if (event.target === dialog) close() }">
        <header><h2 :id="titleId">{{ title }}</h2><button type="button" autofocus @click="close()">Закрыть</button></header>
        <slot :close="close" />
    </dialog>
</template>
