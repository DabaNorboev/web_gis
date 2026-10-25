// A profile can route ordinary map-wheel scrolling to its independent sidebar.
// Mobile keeps native document scrolling; modified wheel remains with MapLibre.
export function scrollMapSidebar(event: WheelEvent, sidebar?: HTMLElement | null) {
    if (!sidebar || event.ctrlKey || event.metaKey || !window.matchMedia('(min-width: 768px)').matches) return
    const target = event.target
    if (target instanceof Element && target.closest('.map-layers-panel, .city-map-legend, .city-map-object')) return
    event.preventDefault()
    event.stopPropagation()
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? sidebar.clientHeight : 1
    sidebar.scrollTop += event.deltaY * unit
}
