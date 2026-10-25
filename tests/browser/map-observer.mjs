import { Map } from 'maplibre-gl'

// Observe real MapLibre instances through their public API; do not replace the
// renderer, source updates, events or camera behavior. Search maps can coexist.
const maps = []
const on = Map.prototype.on
Map.prototype.on = function (...args) {
    if (!maps.includes(this)) maps.push(this)
    return on.apply(this, args)
}
window.__smokeMap = () => {
    const split = document.querySelector('.comparison-map-split')
    const side = split?.dataset.activeSide ?? 'left'
    const frame = document.querySelector(`#compare-map-${side}`) ?? document.querySelector('.comparison-map-frame')
    return maps.find(map => frame?.contains(map.getCanvas()))
}
window.__smokeMapIn = selector => maps.find(map => document.querySelector(selector)?.contains(map.getCanvas()))
