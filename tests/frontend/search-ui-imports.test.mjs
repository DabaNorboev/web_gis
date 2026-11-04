import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkImportPolicy } from './support/search-ui-policy.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const policy = JSON.parse(readFileSync(new URL('./fixtures/search-ui-import-policy.json', import.meta.url)))
test('P4.1 UI is isolated; the whole P1/P1a/P3 core stays independent of old UI', () => checkImportPolicy(root, policy))

function fixture(t, source, extra = {}, core = '') {
    const dir = mkdtempSync(resolve(tmpdir(), 'search-import-policy-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    for (const [path, text] of Object.entries({
        'resources/js/search-ui/Page.vue': `<script setup lang="ts">${source}</script><template><p>Поиск</p></template>`,
        'resources/js/search/task.ts': core,
        'resources/js/pages/Old.vue': '<template>Прежняя страница</template>',
        'resources/js/composables/old.ts': 'export const old = 1',
        'resources/js/components/Old.vue': '<template>Прежний компонент</template>',
        'resources/css/app.css': 'body {}', ...extra,
    })) {
        const file = resolve(dir, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text)
    }
    return () => checkImportPolicy(dir, { ...policy, styles: [], coreRoots: ['resources/js/search/task.ts'], coreExternalFiles: [] })
}

test('new component and allowed packages pass', t => assert.doesNotThrow(fixture(t, "import Child from './Child.vue'; import {ref} from 'vue'", {
    'resources/js/search-ui/Child.vue': '<template>Новый компонент</template>',
})))
for (const [name, code, extra, core] of [
    ['old SFC', "import Old from '@/pages/Old.vue'"],
    ['old composable', "import {old} from '@/composables/old'"],
    ['old component', "import Old from '@/components/Old.vue'"],
    ['owner from UI', "import type {T} from '../search/task'"],
    ['API from UI', "import {api} from '@/api/client'", { 'resources/js/api/client.ts': 'export const api=1' }],
    ['storage from UI', "import '../search/storage'", { 'resources/js/search/storage.ts': 'export const storage=1' }],
    ['type-only barrel', "import type {T} from './barrel'", { 'resources/js/search-ui/barrel.ts': "export type {T} from '@/composables/old'" }],
    ['dynamic import', "import('@/pages/Old.vue')"],
    ['computed import', "const path='./Child.vue'; import(path)"],
    ['glob', "import.meta.glob('../pages/*.vue')"],
    ['require', "require('@/pages/Old.vue')"],
    ['new package', "import x from 'unapproved-kit'"],
    ['old CSS', "import '../../css/app.css'"],
    ['generated helper escape', "import './helper'", { 'resources/js/search-ui/helper.ts': "export {old} from '@/composables/old'" }],
    ['core type-only old UI', '', {}, "import type {T} from '../composables/old'"],
    ['core transitive type-only old UI', '', { 'resources/js/types/trips.ts': "export type {T} from '../composables/old'" }, "import type {T} from '../types/trips'"],
]) test(`import guard rejects ${name}`, t => assert.throws(fixture(t, code, extra, core), /Forbidden|Computed|Glob/))
