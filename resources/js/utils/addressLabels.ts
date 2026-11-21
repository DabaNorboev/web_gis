import type { AddressObject, LocalAddressDisplay } from '@/types/address'
import type { GeocodingCandidate, GeocodingComponents } from '@/types/geocoding'

function compact(parts: unknown[]): string {
    return parts.map(value => typeof value === 'string' ? value.trim() : '').filter(Boolean).join(', ')
}

export function localAddressLabel(label: string, display?: LocalAddressDisplay): string {
    if (!display) return label
    return compact([display.address_line, display.house_number, display.district]) || 'Адрес'
}

export const localAddressType: Record<AddressObject['object_type'], string> = {
    building: 'Здание', address_point: 'Адресная точка', address_area: 'Адресный контур',
}

export function geocodingAddressLabel(components: GeocodingComponents, level: GeocodingCandidate['precision']['level']): string {
    return compact([components.street, level === 'street' ? null : components.number.raw, components.district])
        || (level === 'street' ? 'Улица' : level === 'locality' ? 'Местность' : 'Адрес')
}

export function distinguishAddressLabels(labels: string[], noun: string | readonly string[]): string[] {
    const key = (label: string) => label.toLocaleLowerCase('ru').replace(/\s+/g, ' ')
    const totals = new Map<string, number>(), seen = new Map<string, number>()
    for (const label of labels) {
        const name = key(label)
        totals.set(name, (totals.get(name) ?? 0) + 1)
    }
    return labels.map((label, position) => {
        const name = key(label)
        if (totals.get(name) === 1) return label
        const index = (seen.get(name) ?? 0) + 1
        seen.set(name, index)
        return `${label} · ${typeof noun === 'string' ? noun : noun[position]} ${index}`
    })
}
