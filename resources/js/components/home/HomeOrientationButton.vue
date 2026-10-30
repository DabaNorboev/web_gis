<script setup lang="ts">
import { computed, inject } from 'vue'
import type { HomeOrientationContext, HomeOrientationTarget } from '@/types/homeOrientations'
const props = defineProps<{ target: HomeOrientationTarget; label: string }>()
const context = inject<HomeOrientationContext | null>('home-orientations', null)
const group = computed(() => context?.owner.find(props.target))
</script>
<template>
    <button v-if="context?.enabled.value" type="button" class="home-orientation-button" :aria-label="`Личный ориентир: ${label}`" @click="context.edit(target, $event)">
        {{ group?.threshold == null ? 'Задать ориентир' : `До ${group.threshold} ${target.kind === 'stop' ? 'м' : 'мин'}` }} <span aria-hidden="true">✎</span>
    </button>
</template>
