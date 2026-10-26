<script setup lang="ts">
import { ref, watch } from 'vue'
const props = defineProps<{ addressUrl: string; personalUrl: string | null }>()
const menu = ref<HTMLDetailsElement | null>(null)
const status = ref('')
const fallback = ref<string | null>(null)
function reset() { status.value = ''; fallback.value = null }
watch(() => [props.addressUrl, props.personalUrl], reset)
async function copy(personal: boolean) {
    const url = personal ? props.personalUrl : props.addressUrl
    if (!url) return
    reset()
    try { await navigator.clipboard.writeText(url); status.value = personal ? 'Ссылка с личными местами скопирована' : 'Ссылка на сравнение адресов скопирована' }
    catch { fallback.value = url; status.value = 'Копирование недоступно. Откройте ссылку ниже и скопируйте адрес страницы.' }
}
function escape(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !menu.value?.open) return
    event.preventDefault(); menu.value.open = false; menu.value.querySelector('summary')?.focus()
}
defineExpose({ reset })
</script>
<template>
    <details ref="menu" class="comparison-share" @keydown="escape">
        <summary>Поделиться</summary>
        <div class="comparison-share-menu" aria-label="Поделиться сравнением">
            <button type="button" @click="copy(false)">Ссылка на сравнение адресов</button>
            <p>Только адреса А/Б и радиус окружения.</p>
            <div class="comparison-share-personal">
                <p v-if="personalUrl">Получатель увидит личные точки, подписи и дорожный выбор. Передавайте ссылку тем, кому готовы их раскрыть.</p>
                <p v-else>Добавьте точки личных мест во вкладке «Поездки», чтобы передать их в ссылке.</p>
                <button type="button" :disabled="!personalUrl" @click="copy(true)">Ссылка с личными местами</button>
            </div>
            <p role="status" aria-live="polite">{{ status }}</p>
            <a v-if="fallback" :href="fallback">Открыть ссылку для копирования</a>
        </div>
    </details>
</template>
<style scoped>
.comparison-share{position:relative;font-size:12px;flex:none}.comparison-share summary{cursor:pointer;list-style:none;border:1px solid #aac4b4;border-radius:8px;padding:8px 12px;min-height:36px;background:#fcfdf9;color:#2d6450;font-weight:600}.comparison-share summary::-webkit-details-marker{display:none}.comparison-share[open] summary{background:#eaf2e3}.comparison-share-menu{position:absolute;z-index:25;right:0;top:calc(100% + 6px);width:min(310px,calc(100vw - 24px));padding:12px;border:1px solid #bdcdbb;border-radius:10px;background:#fcfdf9;box-shadow:0 8px 24px #263f3526;line-height:1.5}.comparison-share-menu button{width:100%;padding:9px;border:1px solid #cbdace;border-radius:7px;min-height:40px;text-align:left;color:#2d6450;background:#f4f7ef}.comparison-share-menu p{font-size:11px;margin:6px 0;color:#536b5c;overflow-wrap:anywhere}.comparison-share-personal{border-top:1px solid #dce5da;padding-top:8px;margin-top:10px}.comparison-share-menu button:disabled{opacity:.6;cursor:not-allowed}.comparison-share-menu a{display:block;padding:8px 0;text-decoration:underline;overflow-wrap:anywhere}.comparison-share-menu p:empty{display:none}:is(summary,button,a):focus-visible{outline:3px solid #2d6450;outline-offset:2px}
</style>
