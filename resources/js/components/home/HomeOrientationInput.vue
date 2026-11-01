<script setup lang="ts">
import { computed, inject, ref, useId, watch } from 'vue'
import type { HomeOrientationContext, HomeOrientationTarget } from '@/types/homeOrientations'
const props = defineProps<{ target: HomeOrientationTarget; label: string }>()
const emit = defineEmits<{ valid: [value: boolean] }>()
const context = inject<HomeOrientationContext | null>('home-orientations', null)
const group = computed(() => context?.owner.find(props.target))
const id = `goal-orientation-${useId()}`
const text = ref(''), error = ref('')
watch([() => JSON.stringify(props.target), () => group.value?.threshold], () => {
    text.value = group.value?.threshold?.toString() ?? ''; error.value = ''; emit('valid', true)
}, { immediate: true })
function update(value: string) { text.value = value; error.value = context?.owner.set(props.target, value) ?? ''; emit('valid', !error.value) }
</script>
<template>
    <div v-if="context?.enabled.value" class="goal-orientation">
        <label :for="id">Ориентировочное время <span class="goal-optional">· необязательно</span></label>
        <div class="goal-orientation-field"><span>До</span><input :id="id" type="text" inputmode="decimal" autocomplete="off" :value="text" :aria-invalid="!!error" :aria-describedby="error ? `${id}-error` : undefined" @input="update(($event.target as HTMLInputElement).value)" /><span>мин</span></div>
        <p :id="`${id}-error`" v-if="error" role="alert">{{ error }}</p>
    </div>
</template>
<style scoped>
.goal-orientation{margin-top:10px}.goal-orientation-field{display:flex;align-items:center;gap:8px;margin-top:5px}.goal-orientation-field input{width:80px;max-width:80px;flex:0 0 80px;min-height:40px;border:1px solid #dfe1dd;border-radius:7px;background:#fff;padding:7px 9px;font:inherit}.goal-optional{color:#697579;font-size:11px}.goal-orientation-hint{color:#697579}.goal-orientation input:focus-visible{outline:3px solid #9682be;outline-offset:2px}.goal-orientation p{font-size:12px}.goal-orientation [role=alert]{color:#a33b35}
</style>
