import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { parse, compileScript } from '@vue/compiler-sfc'
import * as vue from 'vue'
import * as ssr from 'vue/server-renderer'

// Use the installed compilers; dependencies and browser globals are local to
// each evaluation. Never resolve application imports from the filesystem.
export function evaluateModule(source, dependencies = {}, globals = {}) {
    const syntax = ts.createSourceFile('test-module.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const required = new Map()
    for (const statement of syntax.statements) {
        if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue
        const names = []
        if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) {
            const clause = statement.importClause
            if (clause?.name) names.push('default')
            if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
                for (const binding of clause.namedBindings.elements) if (!binding.isTypeOnly) names.push((binding.propertyName ?? binding.name).text)
            }
        } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
            for (const binding of statement.exportClause.elements) if (!binding.isTypeOnly) names.push((binding.propertyName ?? binding.name).text)
        }
        required.set(statement.moduleSpecifier.text, [...(required.get(statement.moduleSpecifier.text) ?? []), ...names])
    }
    const javascript = ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText
    const modules = { vue, 'vue/server-renderer': ssr, ...dependencies }
    const module = { exports: {} }
    new Function('require', 'module', 'exports', ...Object.keys(globals), javascript)(id => {
        if (!Object.hasOwn(modules, id)) throw new Error(`Unresolved test module: ${id}`)
        const value = modules[id]
        for (const name of required.get(id) ?? []) {
            const present = name === 'default' && !value?.__esModule ? value != null : value != null && name in Object(value)
            if (!present) throw new Error(`Missing test export "${name}" from: ${id}`)
        }
        return value
    }, module, module.exports, ...Object.values(globals))
    return module.exports
}

export function loadModule(url, dependencies = {}, globals = {}) {
    return evaluateModule(readFileSync(url, 'utf8'), dependencies, globals)
}

export function loadComponent(url, dependencies = {}, { globals = {}, inlineTemplate = true, ssr: server = true } = {}) {
    const { descriptor, errors } = parse(readFileSync(url, 'utf8'), { filename: String(url) })
    if (errors.length) throw errors[0]
    const { content } = compileScript(descriptor, { id: 'component-test', inlineTemplate, templateOptions: { ssr: server } })
    return evaluateModule(content, dependencies, globals).default
}

// Existing page-state tests inspect selected setup bindings without rendering.
// Parse the SFC and let TypeScript compile imports and the explicit export list.
export function loadSetup(url, bindings, dependencies, globals = {}) {
    const { descriptor, errors } = parse(readFileSync(url, 'utf8'))
    if (errors.length) throw errors[0]
    if (!descriptor.scriptSetup) throw new Error(`Missing script setup: ${url}`)
    const loaded = evaluateModule(`${descriptor.scriptSetup.content}\nexport { ${bindings.join(', ')} }`, dependencies, globals)
    for (const name of bindings) if (!Object.hasOwn(loaded, name)) throw new Error(`Missing test setup binding "${name}" from: ${url}`)
    return loaded
}
