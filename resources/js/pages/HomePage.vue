<script setup lang="ts">
import { MapPin, History, MoveUpRight } from '@lucide/vue'
import AddressSearch from '@/components/AddressSearch.vue'
import CityMap from '@/components/map/CityMap.vue'
import TransportResults from '@/components/TransportResults.vue'
import { useTransportAnalysis } from '@/composables/useTransportAnalysis'

const { point, analysis, status, selectPoint, reset } = useTransportAnalysis()
</script>

<template>
    <div class="placelens-shell">
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
            <div class="city-label"><MapPin class="size-4" aria-hidden="true" /><span>Красноярск</span></div>
        </header>

        <main class="placelens-workspace">
            <aside class="place-panel" :aria-labelledby="point ? 'transport-title' : 'intro-title'">
                <div class="place-panel-content" :class="{ 'has-analysis': point }">
                    <section v-if="!point" class="place-intro">
                        <div class="intro-eyebrow"><span class="h-px w-6 bg-[#51836b]" /> ГОРОД В ДЕТАЛЯХ</div>
                        <h1 id="intro-title">Узнайте место<br class="hidden md:block" /> ближе.</h1>
                        <p>Что стоит знать о месте перед тем, как здесь жить?</p>
                    </section>

                    <section class="place-search" aria-labelledby="search-title">
                        <h2 id="search-title">С какого адреса начнём?</h2>
                        <AddressSearch />
                    </section>

                    <div v-if="!point" class="explore-hint">
                        <span class="explore-hint-icon"><MoveUpRight class="size-4" aria-hidden="true" /></span>
                        <p>Нажмите на карту, чтобы узнать<br /> о транспорте вокруг точки.</p>
                    </div>
                    <TransportResults v-if="point" :point="point" :analysis="analysis" :status="status" @retry="selectPoint(point)" @reset="reset" />
                </div>

                <div class="place-panel-footer">
                    <History class="size-5 shrink-0 text-[#51836b]" aria-hidden="true" />
                    <p>В дальнейшем — окружение дома<br /> и история изменений территории.</p>
                </div>
            </aside>

            <section class="placelens-map" aria-label="Карта Красноярска">
                <CityMap :point="point" :analysis="analysis" @select="selectPoint" />
                <div class="map-caption" aria-hidden="true"><span class="h-1.5 w-1.5 rounded-full bg-[#51836b]" /> КАРТА ГОРОДА</div>
            </section>
        </main>
    </div>
</template>
