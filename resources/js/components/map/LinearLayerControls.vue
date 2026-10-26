<script setup lang="ts">
import type { LinearVisibility } from '@/types/profile'
defineProps<{ modelValue: LinearVisibility; comparison?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: LinearVisibility] }>()
const layers = [{ key: 'roads', label: 'Крупные дороги' }, { key: 'railways', label: 'Железнодорожные линии' }] as const
</script>

<template>
    <fieldset class="flex flex-wrap gap-x-5 gap-y-3 px-4 py-3 text-sm">
        <legend class="px-1 text-xs text-[#637769]">{{ comparison ? 'Линии OSM на обеих картах' : 'Линии OSM' }}</legend>
        <label v-for="layer in layers" :key="layer.key" class="flex cursor-pointer items-center gap-2">
            <input type="checkbox" class="size-4 accent-[#2d6450]" :checked="modelValue[layer.key]" @change="emit('update:modelValue', { ...modelValue, [layer.key]: ($event.target as HTMLInputElement).checked })" />{{ layer.label }}
        </label>
    </fieldset>
</template>
