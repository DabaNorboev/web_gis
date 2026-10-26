<script setup lang="ts">
import { computed, ref } from 'vue'
import { overviewTopics, useOverviewTopics } from '@/composables/useOverviewTopics'
const { selection, configured, storageFailed, includes, toggle, reset } = useOverviewTopics()
defineProps<{ compact?: boolean }>()
const activeSummary = computed(() => selection.value === null ? 'все темы' : selection.value.length ? overviewTopics.filter(topic => selection.value?.includes(topic.id)).map(topic => topic.label).join(', ') : 'темы не выбраны')
const disclosure = ref<HTMLDetailsElement | null>(null)
function configure() {
    if (disclosure.value) { disclosure.value.open = true; disclosure.value.querySelector('input')?.focus() }
}
</script>
<template>
    <div class="overview-topics">
        <details ref="disclosure" class="profile-disclosure">
            <summary>Что важно мне <span class="address-note">· {{ compact ? activeSummary : configured ? `${selection?.length}/5 тем` : 'исходный обзор' }}</span></summary>
            <fieldset><legend>Темы основного обзора</legend>
                <label v-for="topic in overviewTopics" :key="topic.id"><input type="checkbox" :checked="includes(topic.id)" @change="toggle(topic.id)">{{ topic.label }}</label>
            </fieldset>
            <p class="address-note">Это интерес к информации, а не желание жить ближе к объекту. Слои карты выбираются отдельно.</p>
            <button type="button" class="profile-action" @click="reset">Сбросить к исходному обзору</button>
            <p class="address-note">Общие настройки профиля и сравнения — только в этом браузере. Ссылка их не передаёт.</p>
        </details>
        <p v-if="!compact && configured && selection?.length" class="address-note">Обзор настроен. Остальные темы — в «Все показатели».</p>
        <p v-if="configured && !selection?.length" class="address-warning">Темы не выбраны. <button type="button" class="profile-action" @click="configure">Настроить обзор</button> или откройте «Все показатели».</p>
        <p v-if="storageFailed" role="status" class="address-note">Не удалось сохранить настройки в браузере. Выбор действует на открытой странице.</p>
    </div>
</template>
<style scoped>
.overview-topics { margin-block: 10px; font-size: 12px; }
fieldset { display: flex; flex-wrap: wrap; gap: 4px 12px; padding-block: 6px; }
legend { font-weight: 600; padding-top: 8px; }
label { display: flex; align-items: center; gap: 7px; min-height: 32px; cursor: pointer; }
input { accent-color: #2d6450; }
:is(summary, input, button):focus-visible { outline: 3px solid #2d6450; outline-offset: 3px; }
</style>
