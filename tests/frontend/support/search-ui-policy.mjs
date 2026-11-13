import { readFileSync, readdirSync, realpathSync, existsSync } from 'node:fs'
import { resolve, relative, dirname, extname } from 'node:path'
import ts from 'typescript'
import { parse } from '@vue/compiler-sfc'

export function sourceFiles(root) {
    return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
        const path = resolve(root, entry.name)
        return entry.isDirectory() ? sourceFiles(path) : /\.(vue|[cm]?[jt]sx?|css)$/.test(path) ? [path] : []
    })
}

export const forbiddenUiWords = [
    'owner', 'composable', 'backend', 'frontend', 'API', 'runtime', 'payload',
    'candidateId', 'placeId', 'schemaVersion', 'IndexedDB', 'localStorage',
    'undefined', 'NaN', 'UNKNOWN', 'null', 'бэкенд', 'фронтенд',
]

export function assertUiText(text) {
    for (const word of forbiddenUiWords) {
        const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        if (new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(text)) throw Error(`Technical word in UI: ${word}`)
    }
}
