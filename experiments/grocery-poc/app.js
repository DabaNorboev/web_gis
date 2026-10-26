import * as maplibregl from '/vendor/maplibre-gl.mjs';

const $ = (id) => document.getElementById(id);
const sides = ['left', 'right'];
const state = { left: null, right: null, radius: 500, response: null };
const maps = {};
const searchRequests = {};
const timers = {};
let compareRequest;
let generation = 0;
const empty = () => ({ type: 'FeatureCollection', features: [] });

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

async function getJson(url, signal) {
  const response = await fetch(url, { signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? 'Ошибка локального сервера');
  return result;
}

function invalidate() {
  generation++;
  compareRequest?.abort();
  state.response = null;
  for (const side of sides) {
    $(side + '-result').replaceChildren(node('p', 'Нужно обновить результат для выбранных адресов и радиуса.'));
    const entry = maps[side];
    entry.collection = empty();
    entry.area = empty();
    entry.pendingResult = null;
    entry.selected = null;
    if (entry.loaded) {
      entry.map.getSource('groceries').setData(entry.collection);
      entry.map.getSource('area').setData(entry.area);
    }
    entry.marker?.remove();
    $(side + '-map-status').textContent = 'Результат ещё не рассчитан';
  }
  $('compare').disabled = !(state.left && state.right);
}

function choose(side, address) {
  state[side] = address;
  $(side + '-search').value = address.label;
  $(side + '-options').replaceChildren();
  const choice = node('div', address.label);
  choice.append(node('div', address.id + ' · точка не является подтверждённым входом', 'meta'));
  if (!address.city) choice.append(node('div', 'Населённый пункт в исходном адресе не указан', 'meta'));
  $(side + '-choice').replaceChildren(choice);
  invalidate();
  $('status').textContent = state.left && state.right ? 'Оба адреса выбраны. Можно показать объекты.' : 'Выберите второй адрес';
}

function initSearch(side) {
  const input = $(side + '-search');
  const options = $(side + '-options');
  input.addEventListener('input', () => {
    state[side] = null;
    $(side + '-choice').textContent = 'Выберите конкретный объект из результатов';
    invalidate();
    clearTimeout(timers[side]);
    searchRequests[side]?.abort();
    options.replaceChildren();
    const query = input.value.trim();
    if (query.length < 3) return;
    timers[side] = setTimeout(async () => {
      const controller = new AbortController();
      searchRequests[side] = controller;
      options.replaceChildren(node('p', 'Поиск в локальном снимке…', 'subtle'));
      try {
        const result = await getJson('/api/search?' + new URLSearchParams({ q: query }), controller.signal);
        if (input.value.trim() !== query) return;
        options.replaceChildren();
        for (const address of result.items) {
          const button = node('button', address.label);
          button.type = 'button';
          button.dataset.addressId = address.id;
          button.append(node('small', address.id + ' · ' + address.point.map(x => x.toFixed(6)).join(', ')));
          button.addEventListener('click', () => choose(side, address));
          options.append(button);
        }
        if (!result.items.length) options.append(node('p', 'В локальном адресном наборе не найдено. Это не доказательство отсутствия адреса.', 'subtle'));
      } catch (error) {
        if (error.name !== 'AbortError') options.replaceChildren(node('p', error.message + '. Повторите ввод.', 'error'));
      }
    }, 220);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      options.querySelector('button')?.focus();
    }
    if (event.key === 'Escape') {
      searchRequests[side]?.abort();
      clearTimeout(timers[side]);
      options.replaceChildren();
    }
  });
}

function highlight(side, id, scroll = false) {
  const entry = maps[side];
  for (const row of $(side + '-result').querySelectorAll('[data-osm-id]')) {
    row.classList.toggle('selected', row.dataset.osmId === id);
    if (scroll && row.dataset.osmId === id) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  if (entry.loaded) {
    if (entry.selected) entry.map.setFeatureState({ source: 'groceries', id: entry.selected }, { selected: false });
    entry.map.setFeatureState({ source: 'groceries', id }, { selected: true });
  }
  entry.selected = id;
}

function renderList(side, result) {
  const features = result.collection.features;
  const target = $(side + '-result');
  target.replaceChildren(node('h3', 'Найдено элементов OSM: ' + features.length));
  target.append(node('p', 'Расстояния по прямой до точки или геометрии; не до подтверждённого входа.', 'meta'));
  if (!features.length) {
    target.append(node('p', 'В этом снимке в выбранном радиусе объекты не найдены. Это не означает, что магазинов на местности нет.', 'empty'));
    return;
  }
  const list = node('ol');
  for (const feature of features) {
    const p = feature.properties;
    const item = node('li', undefined, 'poi');
    item.dataset.osmId = p.id;
    const button = node('button', `${p.ordinal}. ${p.name || 'Название в OSM не указано'} · ${Math.round(p.distance_m)} м`);
    button.type = 'button';
    button.addEventListener('click', () => {
      highlight(side, p.id);
      const b = p.bounds;
      maps[side].map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 65, maxZoom: 17, duration: 300 });
    });
    item.append(button, node('div', `shop=${p.shop} · ${p.geometry_type}`, 'meta'));
    item.append(node('div', p.address || 'Адрес на элементе OSM не указан', 'meta'));
    item.append(node('div', `Версия ${p.version}; изменение ${p.edited_at.slice(0, 10)} — не дата проверки работы`, 'meta'));
    for (const [text, href] of [[p.id + ' ↗', p.source_url], ['Версия в снимке ↗', p.version_url]]) {
      const link = node('a', text);
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      item.append(link);
    }
    list.append(item);
  }
  target.append(list);
}

function renderMap(side, result) {
  const entry = maps[side];
  entry.collection = result.collection;
  entry.area = result.area;
  entry.pendingResult = result;
  if (!entry.loaded) return;
  entry.map.getSource('groceries').setData(entry.collection);
  entry.map.getSource('area').setData(entry.area);
  entry.selected = null;
  entry.marker?.remove();
  const pin = node('div', side === 'left' ? 'A' : 'B', 'address-pin');
  entry.marker = new maplibregl.Marker({ element: pin }).setLngLat(result.address.point).addTo(entry.map);
  const b = result.view_bounds;
  entry.map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 28, duration: 0 });
  $(side + '-map-status').textContent = 'Карта: ' + entry.collection.features.length + ' элементов OSM · ' + result.radius_m + ' м';
}

function createMap(side, roads) {
  const map = new maplibregl.Map({
    container: side + '-map', center: [92.9, 56.03], zoom: 11,
    attributionControl: false,
    style: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#edf1e9' } }] },
  });
  maps[side] = { map, collection: empty(), area: empty(), loaded: false, selected: null };
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }));
  map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: '© OpenStreetMap contributors · ODbL' }));
  map.on('error', (event) => { $(side + '-map-status').textContent = 'Ошибка карты: ' + (event.error?.message || 'неизвестно'); });
  map.on('load', async () => {
    const entry = maps[side];
    map.addSource('roads', { type: 'geojson', data: await roads });
    map.addLayer({ id: 'roads', type: 'line', source: 'roads', paint: { 'line-color': '#c6d1c7', 'line-width': 2 } });
    map.addSource('area', { type: 'geojson', data: empty() });
    map.addLayer({ id: 'area-fill', type: 'fill', source: 'area', paint: { 'fill-color': side === 'left' ? '#30996f' : '#557fb8', 'fill-opacity': .08 } });
    map.addLayer({ id: 'area-line', type: 'line', source: 'area', paint: { 'line-color': '#709c86', 'line-width': 1.5, 'line-dasharray': [3, 2] } });
    map.addSource('groceries', { type: 'geojson', data: entry.collection });
    const color = ['case', ['boolean', ['feature-state', 'selected'], false], '#d09526', '#217857'];
    map.addLayer({ id: 'food-fill', type: 'fill', source: 'groceries', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': color, 'fill-opacity': .5 } });
    map.addLayer({ id: 'food-line', type: 'line', source: 'groceries', filter: ['!=', '$type', 'Point'], paint: { 'line-color': color, 'line-width': 3 } });
    map.addLayer({ id: 'food-point', type: 'circle', source: 'groceries', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 7, 'circle-color': color, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    for (const layer of ['food-fill', 'food-line', 'food-point']) {
      map.on('click', layer, (event) => {
        const id = event.features?.[0]?.properties.id;
        if (id) highlight(side, id, true);
      });
      map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
    }
    entry.loaded = true;
    if (entry.pendingResult) renderMap(side, entry.pendingResult);
    else $(side + '-map-status').textContent = 'Локальная карта готова';
  });
}

async function compare() {
  if (!state.left || !state.right) return;
  invalidate();
  const current = generation;
  const controller = new AbortController();
  compareRequest = controller;
  $('status').textContent = 'Расчёт по локальному снимку…';
  try {
    const params = new URLSearchParams({ left: state.left.id, right: state.right.id, radius_m: state.radius });
    const response = await getJson('/api/compare?' + params, controller.signal);
    if (current !== generation) return;
    state.response = response;
    for (const side of sides) {
      renderList(side, response[side]);
      renderMap(side, response[side]);
    }
    history.replaceState(null, '', '?' + params);
    $('status').textContent = 'Оба результата обновлены · полнота и актуальность неизвестны';
  } catch (error) {
    if (error.name !== 'AbortError') {
      $('status').textContent = error.message + '. Можно повторить расчёт.';
      for (const side of sides) $(side + '-result').replaceChildren(node('p', error.message, 'error'));
    }
  }
}

async function start() {
  const roads = getJson('/api/roads');
  for (const side of sides) {
    createMap(side, roads);
    initSearch(side);
  }
  $('compare').addEventListener('click', compare);
  for (const radio of document.querySelectorAll('input[name=radius]')) radio.addEventListener('change', () => {
    state.radius = Number(radio.value);
    invalidate();
    if (state.left && state.right) compare();
  });
  const meta = await getJson('/api/meta');
  $('snapshot').textContent = `OSM-снимок: ${meta.snapshot}; дата наблюдения неизвестна. Адресных элементов: ${meta.counts.addresses}.`;
  const params = new URLSearchParams(location.search);
  if (params.has('left') && params.has('right')) {
    const restored = await getJson('/api/compare?' + params);
    state.radius = restored.radius_m;
    document.querySelector(`input[name=radius][value="${state.radius}"]`).checked = true;
    for (const side of sides) choose(side, restored[side].address);
    await compare();
  }
}

// Read-only verification surface: compare actual map source and rendered list IDs.
window.groceryPoc = {
  getResponse: () => state.response,
  mapIds: (side) => maps[side]?.map.getSource('groceries')?.serialize().data.features.map(f => f.properties.id) ?? [],
  renderedIds: (side) => [...new Set(maps[side]?.map.queryRenderedFeatures({ layers: ['food-point', 'food-line', 'food-fill'] }).map(f => f.properties.id) ?? [])],
  mapsReady: () => sides.every(side => maps[side]?.loaded),
};
start().catch(error => { $('status').textContent = 'PoC не готов: ' + error.message; });
