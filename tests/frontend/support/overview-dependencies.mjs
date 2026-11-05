import { readFileSync } from 'node:fs'
import { evaluateModule, loadComponent } from './vue-component.mjs'
const source = (folder, name) => readFileSync(new URL(`../../../resources/js/${folder}/${name}.ts`, import.meta.url), 'utf8')
export const topics = evaluateModule(source('composables', 'useOverviewTopics'))
export const display = evaluateModule(source('utils', 'metricDisplay'))
const presentation = evaluateModule(source('utils', 'profilePresentation'))
const comparison = evaluateModule(source('utils', 'comparisonPresentation'), { './profilePresentation': presentation })
export const facts = evaluateModule(source('utils', 'comparisonFacts'), { './comparisonPresentation': comparison, './metricDisplay': display })
