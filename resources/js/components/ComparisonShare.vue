<script setup lang="ts">
import { ref, watch } from 'vue'
const props = defineProps<{ addressUrl: string; personalUrl: string | null; sessionOrientations?: boolean; simple?: boolean }>()
const menu = ref<HTMLDetailsElement | null>(null)
const status = ref('')
const fallback = ref<string | null>(null)
function reset() { status.value = ''; fallback.value = null }
watch(() => [props.addressUrl, props.personalUrl], reset)
async function copy(personal: boolean) {
    const url = personal ? props.personalUrl : props.addressUrl
    if (!url) return
    reset()
    try { await navigator.clipboard.writeText(url); status.value = props.simple ? 'Ссылка скопирована' : personal ? 'Ссылка с личными местами скопирована' : 'Ссылка на сравнение адресов скопирована' }
    catch { fallback.value = url; status.value = 'Копирование недоступно. Откройте ссылку ниже и скопируйте адрес страницы.' }
}
function escape(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !menu.value?.open) return
    event.preventDefault(); menu.value.open = false; menu.value.querySelector('summary')?.focus()
}
defineExpose({ reset })
</script>
<template>
    <div v-if="simple" class="home-share-button">
        <button type="button" @click="copy(!!personalUrl)">Поделиться</button>
        <p v-if="status" class="home-share-notice" role="status" aria-live="polite">{{ status }}</p>
        <a v-if="fallback" :href="fallback">Открыть ссылку для копирования</a>
    </div>
    <details v-else ref="menu" class="comparison-share" @keydown="escape">
        <summary>Поделиться</summary>
        <div class="comparison-share-menu" aria-label="Поделиться сравнением">
            <p v-if="sessionOrientations">Ориентиры действуют в этом сеансе и не входят в ссылку</p>
            <button type="button" @click="copy(false)">Ссылка на сравнение адресов</button>
            <p>Только адреса А/Б и радиус окружения.</p>
            <div class="comparison-share-personal">
                <p v-if="personalUrl">Получатель увидит личные точки, подписи и дорожный выбор. Передавайте ссылку тем, кому готовы их раскрыть.</p>
                <p v-else>Добавьте точки личных мест в разделе «Мои места», чтобы передать их в ссылке.</p>
                <button type="button" :disabled="!personalUrl" @click="copy(true)">Ссылка с личными местами</button>
            </div>
            <p role="status" aria-live="polite">{{ status }}</p>
            <a v-if="fallback" :href="fallback">Открыть ссылку для копирования</a>
        </div>
    </details>
</template>
<style scoped>
.home-share-button{position:relative;font-size:12px}.home-share-button>button{width:100%;min-height:40px;padding:8px 12px;text-align:left;border:1px solid #ddd3eb;border-radius:8px;background:#fff;color:#7058a5;font-weight:600}.home-share-notice{margin-top:8px;padding:9px 12px;border-radius:8px;background:#efeaf6;color:#594779;line-height:1.5}.home-share-button>a{display:block;overflow-wrap:anywhere;margin-top:8px;text-decoration:underline}

.comparison-share{position:relative;font-size:12px;flex:none}.comparison-share summary{cursor:pointer;list-style:none;border:1px solid #ddd3eb;border-radius:8px;padding:8px 12px;min-height:36px;background:#fff;color:#7058a5;font-weight:600}.comparison-share summary::-webkit-details-marker{display:none}.comparison-share[open] summary{background:#efeaf6}.comparison-share-menu{position:relative;z-index:1;width:100%;margin-top:6px;box-sizing:border-box;padding:12px;border:1px solid #ddd3eb;border-radius:10px;background:#fff;box-shadow:0 8px 24px #263f3526;line-height:1.5}.comparison-share-menu button{width:100%;padding:9px;border:1px solid #ddd3eb;border-radius:7px;min-height:40px;text-align:left;color:#7058a5;background:#faf8fd}.comparison-share-menu p{font-size:11px;margin:6px 0;color:#626f78;overflow-wrap:anywhere}.comparison-share-personal{border-top:1px solid #e3deeb;padding-top:8px;margin-top:10px}.comparison-share-menu button:disabled{opacity:.6;cursor:not-allowed}.comparison-share-menu a{display:block;padding:8px 0;text-decoration:underline;overflow-wrap:anywhere}.comparison-share-menu p:empty{display:none}:is(summary,button,a):focus-visible{outline:3px solid #7058a5;outline-offset:2px}
</style>
