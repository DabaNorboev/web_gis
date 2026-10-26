import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

// Presentation only: keep the mounted map and result details, never reload profiles.
export function useComparisonView(context: () => string = () => 'default') {
    const toolbar = ref<HTMLElement | null>(null)
    const mapPanel = ref<HTMLElement | null>(null)
    const results = ref<HTMLElement | null>(null)
    const toolbarHeight = ref(0)
    const mapTop = ref(0)
    const mapFocused = ref(false)
    const readings = new Map<string, { element: HTMLElement; offset: number; focus: HTMLElement | null }>()
    const panelReadings = new Map<string, { panel: HTMLElement; scroll: number; focus: HTMLElement | null; pageY: number }>()
    const readingFocus = new Map<string, HTMLElement>()
    let observer: ResizeObserver | undefined
    let frame = 0
    const pageChrome = new Map<HTMLElement, boolean>()

    function measure() {
        // The narrow map view covers the document header; exclude that covered
        // navigation from keyboard focus, then restore its original state.
        const fullscreen = mapFocused.value && window.innerWidth < 1100
        for (const element of document.querySelectorAll<HTMLElement>('.placelens-shell > .placelens-header, .placelens-shell > .skip-link')) {
            if (!pageChrome.has(element)) pageChrome.set(element, element.inert)
            element.inert = fullscreen || pageChrome.get(element)!
        }
        toolbarHeight.value = toolbar.value?.getBoundingClientRect().height ?? 0
        mapTop.value = Math.max(toolbarHeight.value + 12, mapPanel.value?.getBoundingClientRect().top ?? 0)
    }
    function scheduleMeasure() {
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(measure)
    }
    function rememberFocus(event: FocusEvent) { readingFocus.set(context(), event.target as HTMLElement) }
    function rememberReading() {
        const lastReadingFocus = readingFocus.get(context()) ?? null
        if (!mapFocused.value) {
            const panel = results.value?.closest?.<HTMLElement>('.comparison-sidebar')
            const active = document.activeElement as HTMLElement | null
            if (panel) panelReadings.set(context(), { panel, scroll: panel.scrollTop, focus: active && results.value?.contains(active) ? active : lastReadingFocus && results.value?.contains(lastReadingFocus) ? lastReadingFocus : active && panel.contains(active) ? active : null, pageY: window.scrollY })
        }
        if (!mapFocused.value && results.value) {
            const edge = toolbar.value?.getBoundingClientRect().bottom ?? 0
            const rows = [...results.value.querySelectorAll<HTMLElement>('.comparison-row, .comparison-limitations, .personal-place')]
            const element = rows.find(row => row.getBoundingClientRect().bottom > edge + 12) ?? results.value
            const active = document.activeElement as HTMLElement | null
            const candidate = active && results.value.contains(active) ? active : lastReadingFocus
            const bounds = candidate?.getBoundingClientRect()
            const focus = bounds && bounds.bottom > edge && bounds.top < window.innerHeight ? candidate : null
            const anchor = focus ?? element
            const offset = anchor.getBoundingClientRect().top - edge
            readings.set(context(), { element: anchor, offset: focus ? offset : Math.max(12, offset), focus })
        }
    }
    async function showMap() {
        rememberReading()
        mapFocused.value = window.innerWidth < 1100
        await nextTick()
        measure()
        if (window.innerWidth < 1100) mapPanel.value?.scrollIntoView({ block: 'start' })
        mapPanel.value?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
        scheduleMeasure()
    }
    async function restoreReading(restoreFocus = true) {
        await nextTick()
        measure()
        const panelReading = panelReadings.get(context()), reading = readings.get(context())
        if (panelReading) {
            panelReading.panel.scrollTop = panelReading.scroll
            window.scrollTo(0, panelReading.pageY)
            if (reading?.element.isConnected && reading.element.getClientRects().length) {
                const shift = reading.element.getBoundingClientRect().top - (toolbar.value?.getBoundingClientRect().bottom ?? 0) - reading.offset
                if (window.innerWidth >= 1100) panelReading.panel.scrollTop += shift
                else window.scrollBy(0, shift)
            }
            const focus = panelReading.focus
            if (restoreFocus && focus?.isConnected && focus.getClientRects().length) focus.focus({ preventScroll: true })
            else if (restoreFocus) results.value?.focus({ preventScroll: true })
        } else if (reading?.element.isConnected) {
            window.scrollBy(0, reading.element.getBoundingClientRect().top - toolbarHeight.value - reading.offset)
            const target = reading.focus?.isConnected ? reading.focus : reading.element.querySelector<HTMLElement>('h3, h2, summary')
            if (restoreFocus) target?.focus({ preventScroll: true })
        } else {
            if (!restoreFocus) {
                const panel = results.value?.closest?.<HTMLElement>('.comparison-sidebar')
                if (panel) panel.scrollTop = 0
                if (window.innerWidth < 1100 && results.value) {
                    const navigation = panel?.querySelector<HTMLElement>('.comparison-navigation')?.getBoundingClientRect().height ?? 0
                    window.scrollBy(0, results.value.getBoundingClientRect().top - toolbarHeight.value - navigation)
                }
            }
            if (restoreFocus) results.value?.scrollIntoView({ block: 'start' })
            if (restoreFocus) results.value?.focus({ preventScroll: true })
        }
        scheduleMeasure()
    }
    async function showIndicators() {
        mapFocused.value = false
        await restoreReading()
    }
    async function showLimitations() {
        await showIndicators()
        document.getElementById('compare-limitations')?.scrollIntoView({ block: 'start' })
        document.querySelector<HTMLElement>('#compare-limitations summary')?.focus({ preventScroll: true })
    }
    onMounted(() => {
        observer = new ResizeObserver(scheduleMeasure)
        for (const element of [toolbar.value, mapPanel.value, results.value]) if (element) observer.observe(element)
        results.value?.addEventListener('focusin', rememberFocus)
        window.addEventListener('scroll', scheduleMeasure, { passive: true })
        window.addEventListener('resize', scheduleMeasure)
        window.visualViewport?.addEventListener('resize', scheduleMeasure)
        measure()
        if (window.location.hash === '#compare-maps') void showMap()
    })
    onBeforeUnmount(() => {
        observer?.disconnect()
        for (const [element, inert] of pageChrome) element.inert = inert
        results.value?.removeEventListener('focusin', rememberFocus)
        cancelAnimationFrame(frame)
        window.removeEventListener('scroll', scheduleMeasure)
        window.removeEventListener('resize', scheduleMeasure)
        window.visualViewport?.removeEventListener('resize', scheduleMeasure)
    })
    return { toolbar, mapPanel, results, toolbarHeight, mapTop, mapFocused, showMap, showIndicators, showLimitations, rememberReading, restoreReading }
}
