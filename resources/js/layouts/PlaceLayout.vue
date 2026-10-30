<script setup lang="ts">
import { MapPin } from '@lucide/vue'
import InterfaceSwitch from '@/components/InterfaceSwitch.vue'
import { useInterfacePreference } from '@/composables/useInterfacePreference'
defineProps<{ document?: boolean }>()
const { isWorkspace } = useInterfacePreference()
const isHome = typeof window !== 'undefined' && window.location.pathname === '/'
const isComparison = typeof window !== 'undefined' && window.location.pathname === '/compare'
const isTrips = typeof window !== 'undefined' && window.location.pathname === '/trips'
function contentLink(event: MouseEvent) {
    if ((event.currentTarget as HTMLAnchorElement).getAttribute('href') !== '#main-content') return
    event.preventDefault()
    const target = document.getElementById('main-content')
    if (target) { target.tabIndex = -1; target.scrollIntoView(); target.focus({ preventScroll: true }) }
}
</script>

<template>
    <div class="placelens-shell" :class="{ 'document-shell': document, 'workspace-interface': isWorkspace }">
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
            <nav aria-label="Основная навигация" class="header-nav flex flex-wrap gap-2"><a v-if="isWorkspace" href="/" :aria-current="isHome ? 'page' : undefined" class="header-nav-link">Поиск места</a><a :href="isComparison ? '#main-content' : '/compare'" :aria-current="isComparison ? 'page' : undefined" class="header-nav-link" @click="contentLink">Сравнить адреса</a><a :href="isTrips ? '#main-content' : '/trips'" :aria-current="isTrips ? 'page' : undefined" class="header-nav-link" @click="contentLink">Поездки · пилот</a></nav>
            <div class="city-label"><MapPin class="size-4" aria-hidden="true" /><span>Красноярск</span></div>
            <div class="interface-choice">
                <InterfaceSwitch />
                <p v-if="isWorkspace" class="interface-preview" role="status">{{ isHome ? 'Новый интерфейс · предварительная версия' : 'Новый интерфейс · этот раздел пока в прежней компоновке' }}</p>
            </div>
        </header>
        <slot />
    </div>
</template>

<style>
.placelens-header{column-gap:16px}
.interface-choice{flex:none;position:relative}
.interface-preview{position:absolute;top:calc(100% + 3px);right:0;width:max-content;max-width:310px;padding:3px 7px;border:1px solid #dce4d9;border-radius:5px;background:#fcfdf9;color:#637769;font-size:10px;line-height:1.4;z-index:2;pointer-events:none}
.workspace-interface .placelens-header{padding-block:12px}
.workspace-interface .header-nav-link{border-color:transparent;border-radius:7px;padding-inline:10px}
.workspace-interface .header-nav-link[aria-current=page]{background:#eaf2df;border-color:#cbdace}
@media(min-width:1100px){.workspace-interface .comparison-page{height:auto;flex:1}}
@media(max-width:1100px) and (min-width:768px){.placelens-header .city-label{display:none}.placelens-header{column-gap:10px;padding-inline:16px}.brand{font-size:22px}.header-nav-link{padding-inline:8px}}
@media(max-width:767px){
    .placelens-header .interface-choice{order:4}
    .placelens-header .header-nav{gap:4px}
    .workspace-interface .placelens-header .interface-choice{order:0;margin-left:auto}
    .workspace-interface .placelens-header .city-label{display:none}
    .workspace-interface .placelens-header{padding:8px 12px}
    .workspace-interface .brand{font-size:21px;gap:7px}
    .workspace-interface .brand-symbol{width:30px;height:30px}
    .workspace-interface .header-nav-link{min-height:40px;padding:6px 8px;font-size:12px}
    .interface-preview{position:static;max-width:180px;font-size:10px;margin-top:3px;border:0;padding:0}
}
</style>
