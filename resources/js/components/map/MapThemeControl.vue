<script setup lang="ts">
import { mapThemes } from '@/utils/mapTheme'
import { useMapTheme } from '@/composables/useMapTheme'
const { theme, setTheme } = useMapTheme()
</script>

<template>
    <div class="map-theme-control" role="group" aria-label="Тема подложки карты">
        <button v-for="item in mapThemes" :key="item.key" type="button" :aria-pressed="theme === item.key" @click="setTheme(item.key)">{{ item.label }}</button>
    </div>
</template>

