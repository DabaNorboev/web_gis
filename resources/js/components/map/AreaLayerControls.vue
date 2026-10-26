<script setup lang="ts">
import type { AreaVisibility } from '@/types/profile'
defineProps<{ modelValue: AreaVisibility; comparison?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: AreaVisibility] }>()
const layers = [{ key: 'parks', label: 'Парки' }, { key: 'vegetation', label: 'Растительные территории' }, { key: 'water', label: 'Водные объекты' }] as const
</script>

<template>
    <fieldset class="flex flex-wrap gap-x-5 gap-y-3 px-4 py-3 text-sm">
        <legend class="px-1 text-xs text-[#637769]">{{ comparison ? 'Слои OSM на обеих картах' : 'Слои OSM' }}</legend>
        <label v-for="layer in layers" :key="layer.key" class="flex cursor-pointer items-center gap-2">
            <input type="checkbox" class="size-4 accent-[#2d6450]" :checked="modelValue[layer.key]" @change="emit('update:modelValue', { ...modelValue, [layer.key]: ($event.target as HTMLInputElement).checked })" />{{ layer.label }}
        </label>
    </fieldset>
</template>
