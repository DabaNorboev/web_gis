<script setup lang="ts">
import { ref } from 'vue'
import SearchShell from './SearchShell.vue'
import { searchCopy as copy } from './copy'
import type { SearchSection } from './copy'
import { Button } from './components/ui/button'
import '../../css/search-ui.css'

const section = ref<SearchSection>('conditions')
</script>

<template>
    <SearchShell :section="section" @navigate="section = $event">
        <p class="search-shell__text">{{ copy[section] }}</p>
        <h2 class="search-shell__title">{{ copy.empty }}</h2>
        <div class="search-shell__actions">
            <Button variant="outline" @click="section = 'conditions'">{{ copy.placesFirst }}</Button>
            <Button variant="outline" @click="section = 'addresses'">{{ copy.addressesFirst }}</Button>
        </div>
        <p class="search-shell__text">{{ copy.pending }}</p>
    </SearchShell>
</template>
