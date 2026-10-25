export interface ScreenAnchor { id: string; number: number; x: number; y: number }
export interface ScreenLabel extends ScreenAnchor { anchorX: number; anchorY: number }

// Only displace screen labels. The source points and contours never move.
// Deterministic placement keeps coincident/nearby candidates separately clickable.
export function placeMapLabels(anchors: ScreenAnchor[], width: number, height: number, obstacles: { x: number; y: number }[] = [], labelWidth = 32, blocked: { left: number; top: number; right: number; bottom: number }[] = []): ScreenLabel[] {
    const placed: ScreenLabel[] = []
    const margin = Math.max(22, labelWidth / 2 + 6), gap = Math.max(38, labelWidth + 6)
    for (const anchor of anchors) {
        if (anchor.x < -20 || anchor.x > width + 20 || anchor.y < -20 || anchor.y > height + 20) continue
        const preferred = { x: Math.max(margin, Math.min(width - margin, anchor.x)), y: Math.max(56, Math.min(height - 75, anchor.y - 24)) }
        const candidates = [preferred]
        // A wide caption needs smaller steps around nearby stops/controls than
        // the full caption-width rings used for separating address candidates.
        if (anchors.length === 1) for (const dy of [-36, 36, -72, 72, 0]) for (const dx of [0, -36, 36, -72, 72]) {
            const point = { x: preferred.x + dx, y: preferred.y + dy }
            if (Math.abs(point.x - anchor.x) >= labelWidth / 2 + 12 || Math.abs(point.y - anchor.y) >= 28) candidates.push(point)
        }
        for (let ring = 1; ring <= anchors.length + 1; ring++) {
            for (let step = 0; step < 8 * ring; step++) {
                const angle = step * Math.PI / (4 * ring)
                candidates.push({ x: anchor.x + Math.cos(angle) * gap * ring, y: anchor.y - 24 + Math.sin(angle) * gap * ring })
            }
        }
        const available = candidates.find(point => point.x >= margin && point.x <= width - margin && point.y >= 56 && point.y <= height - 75 && placed.every(other => Math.abs(point.x - other.x) >= gap || Math.abs(point.y - other.y) >= gap) && blocked.every(rect => point.x + labelWidth / 2 + 6 <= rect.left || point.x - labelWidth / 2 - 6 >= rect.right || point.y + 22 <= rect.top || point.y - 22 >= rect.bottom) && obstacles.every(other => Math.abs(point.x - other.x) >= labelWidth / 2 + 12 || Math.abs(point.y - other.y) >= 28))
        // When the canvas is too small, keep every label in a separate row; the
        // map's minimum size and bounded address groups cover normal use.
        const point = available ?? { x: margin + (placed.length % Math.max(1, Math.floor((width - margin * 2) / gap))) * gap, y: 56 + Math.floor(placed.length / Math.max(1, Math.floor((width - margin * 2) / gap))) * gap }
        placed.push({ ...anchor, ...point, anchorX: anchor.x, anchorY: anchor.y })
    }
    return placed
}
