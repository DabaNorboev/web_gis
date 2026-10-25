<script setup lang="ts">
import { computed } from 'vue'
import type { ComparisonSide } from '@/composables/useAddressComparison'
import type { SideKey } from '@/utils/comparison'
import type { OverviewTopic } from '@/composables/useOverviewTopics'
import { comparisonFacts } from '@/utils/comparisonFacts'
const props = defineProps<{ sides: Record<SideKey, ComparisonSide>; radius: number; selected: readonly OverviewTopic[] | null }>()
const facts = computed(() => comparisonFacts(props.sides, props.radius, props.selected))
function focusRow(id: string) {
    const row = document.getElementById(id)
    if (!row) return
    for (let parent: HTMLElement | null = row; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true
    const details = row.querySelector<HTMLDetailsElement>(':scope > details')
    if (details) details.open = true
    row.focus({ preventScroll: true })
    row.scrollIntoView({ block: 'center', behavior: 'instant' })
}
</script>
<template>
    <section v-if="facts.length" class="comparison-facts" aria-label="Коротко по выбранным темам">
        <h2>Коротко по выбранным темам</h2>
        <ul><li v-for="fact in facts" :key="fact.topic"><a :href="`#${fact.target}`" @click.prevent="focusRow(fact.target)">{{ fact.text }}</a></li></ul>
        <p class="address-note">Только расстояния до объектов набора. Доступ, входы, шум и полнота не подтверждены. Ограничения — в строках и «О данных».</p>
    </section>
</template>
<style scoped>
.comparison-facts { margin-top: 12px; font-size: 12px; line-height: 1.5; }
h2 { font-size: 13px; font-weight: 600; }
ul { display: grid; gap: 7px; margin-block: 8px; }
a { color: #2d6450; text-decoration: underline; text-underline-offset: 3px; }
a:focus-visible { outline: 3px solid #2d6450; outline-offset: 2px; }
</style>
