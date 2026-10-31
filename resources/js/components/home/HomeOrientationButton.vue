<script setup lang="ts">
import { Pencil } from '@lucide/vue'
import { computed, inject } from 'vue'
import type { HomeOrientationContext, HomeOrientationTarget } from '@/types/homeOrientations'
const props = defineProps<{ target: HomeOrientationTarget; label: string }>()
const context = inject<HomeOrientationContext | null>('home-orientations', null)
const group = computed(() => context?.owner.find(props.target))
</script>
<template>
    <span v-if="context?.enabled.value && target.kind === 'trip'" class="home-goal-edit">
        <small v-if="group?.threshold != null">До {{ group.threshold }} мин</small>
        <button type="button" class="home-goal-pencil" :aria-label="`Изменить цель ${label}`" @click="context.edit(target, $event)"><Pencil :size="14" aria-hidden="true" /></button>
    </span>
</template>
