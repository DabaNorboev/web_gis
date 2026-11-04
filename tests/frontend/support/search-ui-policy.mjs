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

// Walk syntax, including type-only edges. Unknown computed dependencies fail closed.
function dependencies(text, file) {
    const found = []
    const script = code => {
        const ast = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
        const literal = node => {
            if (!node || !(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) throw Error(`Computed import: ${file}`)
            found.push(node.text)
        }
        const visit = node => {
            if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) literal(node.moduleSpecifier)
            if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) literal(node.moduleReference.expression)
            if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) literal(node.argument.literal)
            if (ts.isCallExpression(node)) {
                const callee = node.expression.getText(ast)
                if (node.expression.kind === ts.SyntaxKind.ImportKeyword || callee === 'require') literal(node.arguments[0])
                if (callee === 'import.meta.glob' || callee === 'import.meta.globEager') throw Error(`Glob requires an explicit file list: ${file}`)
            }
            ts.forEachChild(node, visit)
        }
        visit(ast)
    }
    const css = code => {
        for (const match of code.matchAll(/@(?:import|reference)\s+(?:url\(\s*)?["']([^"']+)["']/g)) found.push(match[1])
        if (/@(?:import|reference)\s+(?!["']|url\(\s*["'])/.test(code)) throw Error(`Unresolved CSS dependency: ${file}`)
    }
    if (file.endsWith('.vue')) {
        const { descriptor, errors } = parse(text, { filename: file })
        if (errors.length) throw Error(`Invalid SFC: ${file}`)
        for (const block of [descriptor.script, descriptor.scriptSetup]) {
            if (block?.src) found.push(block.src)
            if (block?.content) script(block.content)
        }
        if (descriptor.template?.src) throw Error(`External template is not allowed: ${file}`)
        for (const style of descriptor.styles) { if (style.src) found.push(style.src); css(style.content) }
    } else if (file.endsWith('.css')) css(text)
    else script(text)
    return found
}

export function checkImportPolicy(root, policy) {
    root = realpathSync(root)
    const ui = resolve(root, policy.uiRoot)
    const core = new Set(policy.coreRoots.map(p => resolve(root, p)))
    const styles = new Set(policy.styles.map(p => resolve(root, p)))
    const inside = (file, dir) => file === dir || file.startsWith(`${dir}/`)
    const resolveLocal = (from, specifier) => {
        if (/[?#]/.test(specifier)) throw Error(`Import query is not allowed: ${specifier}`)
        const base = specifier.startsWith('@/') ? resolve(root, 'resources/js', specifier.slice(2)) : resolve(dirname(from), specifier)
        for (const suffix of ['', '.ts', '.js', '.vue', '.json', '/index.ts', '/index.js']) {
            const path = base + suffix
            if (existsSync(path)) {
                try { if (readFileSync(path).length >= 0) return realpathSync(path) } catch { /* directory */ }
            }
        }
        throw Error(`Unresolved dependency: ${relative(root, from)} → ${specifier}`)
    }
    const walk = (entry, kind) => {
        const visited = new Set()
        const external = new Set((kind === 'ui' ? policy.uiExternalFiles : policy.coreExternalFiles).map(p => resolve(root, p)))
        const visit = (file, chain) => {
            file = realpathSync(file)
            const allowed = kind === 'ui' ? inside(file, ui) || styles.has(file) || external.has(file) : core.has(file) || external.has(file)
            if (!allowed) throw Error(`Forbidden import: ${[...chain, relative(root, file)].join(' → ')}`)
            if (visited.has(file)) return
            visited.add(file)
            if (extname(file) === '.json') return
            for (const dep of dependencies(readFileSync(file, 'utf8'), file)) {
                if (dep.startsWith('.') || dep.startsWith('@/')) visit(resolveLocal(file, dep), [...chain, relative(root, file)])
                else if (!policy.packages.includes(dep)) throw Error(`Forbidden package: ${relative(root, file)} → ${dep}`)
            }
        }
        visit(entry, [])
    }
    const files = sourceFiles(ui)
    if (!files.some(p => p.endsWith('.vue'))) throw Error('New UI is empty')
    for (const file of [...files, ...styles]) walk(file, 'ui')
    for (const file of core) walk(file, 'core')
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

// Copy catalog plus literal template text, including accessible attributes and
// expression strings. Identifiers, import paths and CSS classes are not UI copy.
export function checkUiCopy(file, text) {
    const literals = code => {
        const ast = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true)
        const visit = node => {
            if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) assertUiText(node.text)
            ts.forEachChild(node, visit)
        }
        visit(ast)
    }
    if (file.endsWith('/copy.ts')) { literals(text); return }
    if (!file.endsWith('.vue')) return
    const { descriptor } = parse(text)
    const visit = node => {
        if (node.type === 2) assertUiText(node.content)
        if (node.type === 5) literals(node.content.content)
        for (const prop of node.props ?? []) {
            if (prop.type === 6 && ['aria-label', 'aria-description', 'title', 'alt', 'placeholder'].includes(prop.name)) assertUiText(prop.value?.content ?? '')
            if (prop.type === 7 && prop.exp) literals(prop.exp.content)
        }
        for (const child of node.children ?? []) visit(child)
    }
    if (descriptor.template?.ast) visit(descriptor.template.ast)
}
