<script setup lang="ts">
import { MapPin } from '@lucide/vue'
defineProps<{ document?: boolean }>()
const isComparison = typeof window !== 'undefined' && window.location.pathname === '/compare'
const isTrips = typeof window !== 'undefined' && window.location.pathname === '/trips'
function contentLink(event: MouseEvent) {
    if (!isTrips && !isComparison) return
    event.preventDefault()
    const target = document.getElementById('main-content')
    if (target) { target.tabIndex = -1; target.scrollIntoView(); target.focus({ preventScroll: true }) }
}
</script>

<template>
    <div class="placelens-shell" :class="{ 'document-shell': document }">
        <a class="skip-link" href="#main-content" @click="contentLink">Перейти к содержанию</a>
        <header class="placelens-header">
            <a href="/" class="brand" aria-label="PlaceLens — главная">
                <svg class="brand-symbol" viewBox="0 0 40 40" fill="none" aria-hidden="true">
                    <rect width="40" height="40" rx="12" fill="#2D6450" />
                    <path d="M10 13h8a7 7 0 0 1 0 14h-3v5h-5V13Z" stroke="#EAF2DF" stroke-width="2.2" stroke-linejoin="round" />
                    <circle cx="24" cy="18" r="6" stroke="#EAF2DF" stroke-width="2.2" />
                    <path d="m28.5 22.5 4 4" stroke="#EAF2DF" stroke-width="2.2" stroke-linecap="round" />
                </svg>
                <span>Place<span class="text-[#2d6450]">Lens</span></span>
            </a>
            <nav aria-label="Основная навигация" class="header-nav flex flex-wrap gap-2"><a :href="isComparison ? '#main-content' : '/compare'" :aria-current="isComparison ? 'page' : undefined" class="header-nav-link" @click="contentLink">Сравнить адреса</a><a :href="isTrips ? '#main-content' : '/trips'" :aria-current="isTrips ? 'page' : undefined" class="header-nav-link" @click="contentLink">Поездки · пилот</a></nav>
            <div class="city-label"><MapPin class="size-4" aria-hidden="true" /><span>Красноярск</span></div>
        </header>
        <slot />
    </div>
</template>
