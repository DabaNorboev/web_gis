export type AnalysisTab = 'overview' | 'objects' | 'satellite' | 'air'
export type SatelliteMode = 'snapshot' | 'ndvi'
export type PoiCategory = 'grocery' | 'pharmacy' | 'official_stop' | 'park'

export interface DemoPoint { lon: number; lat: number }
export interface DemoPlace extends DemoPoint { id: string | null; label: string }
export interface DemoPoi extends DemoPoint {
    id: string
    category: PoiCategory
    name: string
    distance_m: number
    address: string | null
    hours: string | null
    source: string
    snapshot: string
}
export interface DemoStation extends DemoPoint {
    id: string
    number: number
    name: string
    address: string
    distance_km: number
    pm25: number
    observed_at: string
    selected: boolean
}

export const categoryOrder: PoiCategory[] = ['grocery', 'pharmacy', 'official_stop', 'park']

export const categoryMeta: Record<PoiCategory, { label: string; glyph: string; color: string }> = {
    grocery: { label: 'Продукты', glyph: 'М', color: '#7c3aed' },
    pharmacy: { label: 'Аптеки', glyph: '+', color: '#2f855a' },
    official_stop: { label: 'Остановки', glyph: 'О', color: '#2b6cb0' },
    park: { label: 'Парки', glyph: 'П', color: '#4d7c0f' },
}

// Visual prototype only: every address, coordinate, name, distance and date is synthetic.
export const demoAddresses: DemoPlace[] = [
    { id: 'demo:address:1', label: 'Красноярск, проспект Мира, 73', lon: 92.852, lat: 56.01 },
    { id: 'demo:address:2', label: 'Красноярск, улица Ленина, 102', lon: 92.844, lat: 56.012 },
    { id: 'demo:address:3', label: 'Красноярск, улица Карла Маркса, 93', lon: 92.858, lat: 56.009 },
]

export const initialPlace = demoAddresses[0]!

export const demoPois: DemoPoi[] = [
    { id: 'demo:poi:g1', category: 'grocery', name: 'Магазин «У дома»', lon: 92.8502, lat: 56.0118, distance_m: 180, address: 'проспект Мира, 70', hours: '08:00–22:00', source: 'OpenStreetMap', snapshot: '01.08.2024' },
    { id: 'demo:poi:g2', category: 'grocery', name: 'Супермаркет «Центральный»', lon: 92.8545, lat: 56.0122, distance_m: 260, address: 'проспект Мира, 79', hours: 'круглосуточно', source: 'OpenStreetMap', snapshot: '01.08.2024' },
    { id: 'demo:poi:g3', category: 'grocery', name: 'Магазин «Продукты»', lon: 92.8478, lat: 56.0088, distance_m: 300, address: 'улица Ленина, 98', hours: null, source: 'OpenStreetMap', snapshot: '01.08.2024' },
    { id: 'demo:poi:g4', category: 'grocery', name: 'Магазин «Северный»', lon: 92.8562, lat: 56.0085, distance_m: 340, address: null, hours: null, source: 'OpenStreetMap', snapshot: '01.08.2024' },
    { id: 'demo:poi:g5', category: 'grocery', name: 'Магазин «У Енисея»', lon: 92.851, lat: 56.0068, distance_m: 390, address: 'улица Дубровинского, 58', hours: null, source: 'OpenStreetMap', snapshot: '01.08.2024' },
    { id: 'demo:poi:g6', category: 'grocery', name: 'Магазин «Восточный»', lon: 92.859, lat: 56.011, distance_m: 450, address: null, hours: null, source: 'OpenStreetMap', snapshot: '01.08.2024' },
    { id: 'demo:poi:p1', category: 'pharmacy', name: 'Аптека «Пример»', lon: 92.853, lat: 56.01, distance_m: 240, address: 'проспект Мира, 75', hours: null, source: 'OpenStreetMap', snapshot: '01.08.2024' },
    { id: 'demo:poi:p2', category: 'pharmacy', name: 'Аптека «Здоровье»', lon: 92.8492, lat: 56.0095, distance_m: 370, address: 'улица Ленина, 105', hours: null, source: 'OpenStreetMap', snapshot: '01.08.2024' },
    { id: 'demo:poi:p3', category: 'pharmacy', name: 'Аптека «Городская»', lon: 92.855, lat: 56.0078, distance_m: 460, address: null, hours: null, source: 'OpenStreetMap', snapshot: '01.08.2024' },
    { id: 'demo:poi:s1', category: 'official_stop', name: 'Остановка «Театр»', lon: 92.8505, lat: 56.008, distance_m: 190, address: null, hours: null, source: 'Официальный набор', snapshot: '31.05.2025' },
    { id: 'demo:poi:s2', category: 'official_stop', name: 'Остановка «Проспект Мира»', lon: 92.8538, lat: 56.0126, distance_m: 250, address: null, hours: null, source: 'Официальный набор', snapshot: '31.05.2025' },
    { id: 'demo:poi:s3', category: 'official_stop', name: 'Остановка «Ленина»', lon: 92.8568, lat: 56.0098, distance_m: 280, address: null, hours: null, source: 'Официальный набор', snapshot: '31.05.2025' },
    { id: 'demo:poi:s4', category: 'official_stop', name: 'Остановка «Карла Маркса»', lon: 92.848, lat: 56.0115, distance_m: 310, address: null, hours: null, source: 'Официальный набор', snapshot: '31.05.2025' },
    { id: 'demo:poi:s5', category: 'official_stop', name: 'Остановка «Дубровинского»', lon: 92.8515, lat: 56.0062, distance_m: 360, address: null, hours: null, source: 'Официальный набор', snapshot: '31.05.2025' },
    { id: 'demo:poi:s6', category: 'official_stop', name: 'Остановка «Вейнбаума»', lon: 92.8575, lat: 56.0124, distance_m: 410, address: null, hours: null, source: 'Официальный набор', snapshot: '31.05.2025' },
    { id: 'demo:poi:s7', category: 'official_stop', name: 'Остановка «Мира»', lon: 92.8468, lat: 56.007, distance_m: 430, address: null, hours: null, source: 'Официальный набор', snapshot: '31.05.2025' },
    { id: 'demo:poi:s8', category: 'official_stop', name: 'Остановка «Кирова»', lon: 92.8578, lat: 56.0078, distance_m: 480, address: null, hours: null, source: 'Официальный набор', snapshot: '31.05.2025' },
    { id: 'demo:poi:k1', category: 'park', name: 'Парк «Центральный»', lon: 92.8448, lat: 56.012, distance_m: 470, address: null, hours: null, source: 'OpenStreetMap', snapshot: '01.08.2024' },
    { id: 'demo:poi:k2', category: 'park', name: 'Сквер «Набережный»', lon: 92.857, lat: 56.0075, distance_m: 440, address: null, hours: null, source: 'OpenStreetMap', snapshot: '01.08.2024' },
]

export const demoStations: DemoStation[] = [
    { id: 'demo:station:1', number: 1, name: 'Центр', address: 'улица Ленина, 102', lon: 92.836, lat: 56.007, distance_km: 2.8, pm25: 18.6, observed_at: '15.08.2024 14:00', selected: true },
    { id: 'demo:station:2', number: 2, name: 'Север', address: 'улица Вейнбаума, 1', lon: 92.887, lat: 56.031, distance_km: 3.1, pm25: 12.4, observed_at: '15.08.2024 14:00', selected: false },
    { id: 'demo:station:3', number: 3, name: 'Речная', address: 'улица Дубровинского, 1', lon: 92.874, lat: 56.004, distance_km: 4.9, pm25: 16.2, observed_at: '15.08.2024 14:00', selected: false },
]

export const demoDates = ['15.08.2024', '28.06.2024', '26.07.2024']

export const demoHistory: (number | null)[] = [
    14, 16, 12, 18, 17, 20, 15, null, null, 11, 14, 13, 16, 15,
]

export const staleLayerNotice = 'Макет • условные данные'
