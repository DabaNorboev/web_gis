<script setup lang="ts">
import { useInterfacePreference } from '@/composables/useInterfacePreference'

const { version, setVersion } = useInterfacePreference()
</script>

<template>
    <div class="interface-switch" data-interface-switch role="group" aria-label="Интерфейс">
        <span class="interface-switch-label">Интерфейс</span>
        <button type="button" :aria-pressed="version === 'classic'" @click="setVersion('classic')">Текущий</button>
        <button type="button" :aria-pressed="version === 'workspace'" @click="setVersion('workspace')">Новый</button>
    </div>
</template>

<style scoped>
.interface-switch{display:flex;align-items:center;gap:2px;padding:3px;border:1px solid #cbdace;border-radius:10px;background:#f1f4ed;flex:none}
.interface-switch-label{padding:0 8px;color:#637769;font-size:11px}
.interface-switch button{min-height:32px;padding:6px 10px;border-radius:7px;color:#405a4c;font-size:12px;white-space:nowrap}
.interface-switch button[aria-pressed=true]{background:#2d6450;color:white}
@media(max-width:767px){.interface-switch button{min-height:44px}.interface-switch-label{display:none}}
</style>
