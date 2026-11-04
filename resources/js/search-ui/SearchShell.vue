<script setup lang="ts">
import { searchCopy as copy } from './copy'
import type { SearchSection } from './copy'
import { Button } from './components/ui/button'

defineProps<{ section: SearchSection }>()
const emit = defineEmits<{ navigate: [section: SearchSection] }>()
</script>

<template>
    <div class="search-shell">
        <a class="search-shell__skip" href="#search-content">{{ copy.skip }}</a>
        <header class="search-shell__header">
            <a class="search-shell__brand" href="/">{{ copy.brand }}</a>
            <span>{{ copy.search }}</span>
            <p class="search-shell__text" role="status">{{ copy.temporary }}</p>
        </header>
        <div class="search-shell__workspace">
            <main id="search-content" class="search-shell__panel" tabindex="-1">
                <nav class="search-shell__nav" :aria-label="copy.navigation">
                    <Button :variant="section === 'conditions' ? 'default' : 'outline'" :aria-current="section === 'conditions' ? 'page' : undefined" @click="emit('navigate', 'conditions')">{{ copy.sections.conditions }}</Button>
                    <Button variant="outline" disabled :title="copy.unavailable">{{ copy.sections.territory }}</Button>
                    <Button :variant="section === 'addresses' ? 'default' : 'outline'" :aria-current="section === 'addresses' ? 'page' : undefined" @click="emit('navigate', 'addresses')">{{ copy.sections.addresses }}</Button>
                    <Button variant="outline" disabled :title="copy.unavailable">{{ copy.sections.comparison }}</Button>
                    <Button variant="outline" disabled :title="copy.unavailable">{{ copy.sections.visit }}</Button>
                </nav>
                <h1 class="search-shell__title">{{ copy.sections[section] }}</h1>
                <slot />
            </main>
            <aside class="search-shell__map" :aria-label="copy.map">
                <p class="search-shell__text">{{ copy.mapUnavailable }}</p>
            </aside>
        </div>
    </div>
</template>
