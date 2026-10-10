<script setup lang="ts">
import { ref } from 'vue'
import { Search, X, ArrowRight } from '@lucide/vue'

const query = ref('')
const submitted = ref(false)
</script>

<template>
    <div class="search-area">
        <p id="search-availability" class="search-availability">Поиск адресов скоро появится</p>
        <form class="search-box" role="search" @submit.prevent="submitted = true">
            <Search class="size-5 shrink-0 text-[#708079]" aria-hidden="true" />
            <label for="address-search" class="sr-only">Адрес в Красноярске</label>
            <input
                id="address-search" v-model="query" type="search" autocomplete="off"
                placeholder="Улица и номер дома"
                aria-describedby="search-note search-availability" class="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-[#819087]"
                @input="submitted = false"
            />
            <button v-if="query" type="button" class="search-clear" aria-label="Очистить адрес" @click="query = ''; submitted = false">
                <X class="size-4" aria-hidden="true" />
            </button>
            <button type="submit" class="search-submit" aria-label="Поиск адреса">
                <ArrowRight class="size-5" aria-hidden="true" />
            </button>
        </form>
        <p id="search-note" class="search-note" role="status" aria-live="polite">
            {{ submitted ? 'Поиск пока недоступен. Можно исследовать карту города.' : '' }}
        </p>
    </div>
</template>
