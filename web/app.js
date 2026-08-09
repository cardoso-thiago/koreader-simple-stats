/* ═══════════════════════════════════════════════════════════════════════
   KOReader Estante — Frontend
   ═══════════════════════════════════════════════════════════════════════ */

const API = {
  stats:   '/api/stats',
  status:  '/api/status',
  settings:'/api/settings',
  realPages: '/api/real-pages',
};

/* ── State ─────────────────────────────────────────────────────────────── */
let state = {
  books:         [],
  booksFiltered: [],
  monthlyData:   [],
  monthPage:     0,
  MONTH_PAGE_SZ: 12,
  sortCol:       null,
  sortDir:       'asc',
  filter:        'all',
  searchQuery:   '',
  lastDbMtime:   0,
  etag:          null,
  charts:        {},
  topLists:      {},
  topListMarkup: {},
};

/* ── Settings (server-side, with local cache fallback) ────────────────── */
const ACCENT_PRESETS = [
  { name: 'Carimbo', hex: '#cf5f4a' },
  { name: 'Âmbar',   hex: '#c9a45e' },
  { name: 'Azul',    hex: '#7a9fc4' },
  { name: 'Verde',   hex: '#8fb67e' },
  { name: 'Roxo',    hex: '#a08fc9' },
  { name: 'Rosa',    hex: '#c98a8a' },
  { name: 'Teal',    hex: '#7fb6b0' },
];

const SETTINGS_CACHE_KEY = 'koreader_settings_cache_v2';
const FILTER_OPS = ['contains', 'equals', 'starts_with', 'ends_with'];
const DEFAULT_SETTINGS = {
  accent: null,
  excludeAbandoned: false,
  titleFilters: [],
  authorFilters: [],
};

let settings = { ...DEFAULT_SETTINGS };

let settingsDraft = {};          // working copy while dialog is open
let lastFetchData  = null;       // raw API response for preview computation

function normalizeFilterList(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter(item => item && typeof item === 'object')
    .map(item => ({
      op: FILTER_OPS.includes(item.op) ? item.op : 'contains',
      val: (item.val || '').trim(),
    }))
    .filter(item => item.val.length > 0);
}

function normalizeSettings(raw) {
  const merged = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return merged;

  if (raw.accent == null || raw.accent === '') {
    merged.accent = null;
  } else if (typeof raw.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.accent)) {
    merged.accent = raw.accent.toLowerCase();
  }

  merged.excludeAbandoned = Boolean(raw.excludeAbandoned);
  merged.titleFilters = normalizeFilterList(raw.titleFilters);
  merged.authorFilters = normalizeFilterList(raw.authorFilters);
  return merged;
}

function loadSettingsCache() {
  try {
    const raw = localStorage.getItem(SETTINGS_CACHE_KEY);
    if (!raw) return;
    settings = normalizeSettings(JSON.parse(raw));
  } catch (_) {
  }
}

function saveSettingsCache(nextSettings = settings) {
  try {
    localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(normalizeSettings(nextSettings)));
  } catch (_) {
  }
}

async function loadSettings() {
  loadSettingsCache();

  try {
    const res = await fetch(API.settings);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    settings = normalizeSettings(await res.json());
    saveSettingsCache(settings);
  } catch (_) {
  }
}

async function saveSettings(nextSettings) {
  const normalized = normalizeSettings(nextSettings);
  settings = normalized;
  saveSettingsCache(normalized);

  try {
    const res = await fetch(API.settings, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(normalized),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const saved = normalizeSettings(await res.json());
    settings = saved;
    saveSettingsCache(saved);
    return saved;
  } catch (err) {
    console.warn('Não foi possível sincronizar settings com o backend:', err);
    return normalized;
  }
}

/* ── Accent colour ─────────────────────────────────────────────────────── */
function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return `${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}`;
}

function applyAccent(hex) {
  if (!hex) {
    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--accent-rgb');
  } else {
    document.documentElement.style.setProperty('--accent', hex);
    document.documentElement.style.setProperty('--accent-rgb', hexToRgb(hex));
  }
}

/* ── Build filters JSON for the API ────────────────────────────────────── */
function buildFiltersJSON(s) {
  const f = {};
  if (s.excludeAbandoned)  f.exclude_abandoned = true;
  if (s.titleFilters.length) {
    f.title_filters = s.titleFilters.map(t => ({ op: t.op, val: t.val }));
  }
  if (s.authorFilters.length) {
    f.author_filters = s.authorFilters.map(a => ({ op: a.op, val: a.val }));
  }
  return Object.keys(f).length ? f : null;
}

/* ── Filter matching (local preview) ───────────────────────────────────── */
function matchField(val, filters) {
  if (!filters || !filters.length) return true;
  const bval = (val || '').toLowerCase().trim();
  for (const f of filters) {
    const fval = (f.val || '').toLowerCase().trim();
    if (!fval) continue;
    if (f.op === 'equals'      && bval === fval)           return true;
    if (f.op === 'starts_with' && bval.startsWith(fval))   return true;
    if (f.op === 'ends_with'   && bval.endsWith(fval))     return true;
    if (f.op === 'contains'    && bval.includes(fval))     return true;
  }
  return false;
}

function computeFilterPreview(draft, books) {
  if (!books || !books.length) return null;
  let list = books.slice();
  if (draft.excludeAbandoned) list = list.filter(b => b.status !== 'abandoned');
  list = list.filter(b => !matchField(b.title,  draft.titleFilters));
  list = list.filter(b => !matchField(b.author, draft.authorFilters));
  return list.length;
}

/* ── Update abandoned tab visibility ────────────────────────────────── */
function updateAbandonedTab() {
  const tab = document.getElementById('tab-abandoned');
  const hasAbandoned = state.books.some(b => b.status === 'abandoned');
  tab.classList.toggle('hidden', settings.excludeAbandoned || !hasAbandoned);
  if (state.filter === 'abandoned' && tab.classList.contains('hidden')) {
    state.filter = 'all';
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));
  }
}

/* ── Settings dialog ───────────────────────────────────────────────────── */
function renderAccentSwatches(container, currentHex) {
  container.innerHTML = '';
  ACCENT_PRESETS.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'accent-swatch' + (p.hex === currentHex ? ' active' : '');
    btn.style.background = p.hex;
    btn.title = p.name;
    btn.dataset.hex = p.hex;
    container.appendChild(btn);
  });
  // Reset button
  const reset = document.createElement('button');
  reset.className = 'accent-swatch accent-swatch--reset' + (!currentHex ? ' active' : '');
  reset.textContent = '↺ Original';
  reset.dataset.reset = '1';
  container.appendChild(reset);
}

const FILTER_OPTS = [
  ['contains',    'contém'],
  ['equals',      'igual a'],
  ['starts_with', 'inicia com'],
  ['ends_with',   'termina com'],
];

function createFilterRow(op, val, onChange) {
  const row = document.createElement('div');
  row.className = 'filter-row';

  const sel = document.createElement('select');
  FILTER_OPTS.forEach(([v, label]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    if (v === op) o.selected = true;
    sel.appendChild(o);
  });
  sel.addEventListener('change', onChange);

  const inp = document.createElement('input');
  inp.type = 'text';
  inp.value = val || '';
  inp.placeholder = 'Valor…';
  inp.addEventListener('input', onChange);

  const rm = document.createElement('button');
  rm.className = 'filter-remove';
  rm.textContent = '×';
  rm.title = 'Remover filtro';
  rm.setAttribute('aria-label', 'Remover filtro');
  rm.addEventListener('click', () => { row.remove(); onChange(); });

  row.appendChild(sel);
  row.appendChild(inp);
  row.appendChild(rm);
  return row;
}

function renderFilterRows(container, filters, onChange) {
  container.innerHTML = '';
  filters.forEach(f => {
    container.appendChild(createFilterRow(f.op, f.val, onChange));
  });
}

function readFilterDraft() {
  const title = [];
  document.querySelectorAll('#title-filter-list .filter-row').forEach(row => {
    const sel = row.querySelector('select');
    const inp = row.querySelector('input');
    if (inp.value.trim()) title.push({ op: sel.value, val: inp.value.trim() });
  });
  const author = [];
  document.querySelectorAll('#author-filter-list .filter-row').forEach(row => {
    const sel = row.querySelector('select');
    const inp = row.querySelector('input');
    if (inp.value.trim()) author.push({ op: sel.value, val: inp.value.trim() });
  });
  return {
    accent:           settingsDraft.accent,
    excludeAbandoned: document.getElementById('toggle-exclude-abandoned').checked,
    titleFilters:     title,
    authorFilters:    author,
  };
}

function updateFilterPreview() {
  const draft = readFilterDraft();
  const cnt = computeFilterPreview(draft, lastFetchData ? lastFetchData.books : null);
  const el  = document.getElementById('filter-preview');
  if (cnt === null) {
    el.textContent = 'Carregue os dados para ver a prévia dos filtros.';
  } else {
    const total = lastFetchData ? lastFetchData.books.length : 0;
    const hidden = total - cnt;
    const parts = [];
    if (cnt < total) {
      parts.push(`<strong>${cnt}</strong> livro${cnt !== 1 ? 's' : ''} exibido${cnt !== 1 ? 's' : ''}`);
      parts.push(`<strong>${hidden}</strong> ocultado${hidden !== 1 ? 's' : ''}`);
    } else {
      parts.push(`<strong>${cnt}</strong> livro${cnt !== 1 ? 's' : ''} (todos exibidos)`);
    }
    el.innerHTML = parts.join(' · ');
  }
}

function openSettings() {
  settingsDraft = JSON.parse(JSON.stringify(settings));
  const d = settingsDraft;

  // Accent swatches
  renderAccentSwatches(document.getElementById('accent-picker'), d.accent);

  // Toggle
  document.getElementById('toggle-exclude-abandoned').checked = d.excludeAbandoned;

  // Filter rows
  const titleContainer = document.getElementById('title-filter-list');
  const authorContainer = document.getElementById('author-filter-list');
  const onChange = updateFilterPreview;
  renderFilterRows(titleContainer, d.titleFilters, onChange);
  renderFilterRows(authorContainer, d.authorFilters, onChange);

  // Preview
  updateFilterPreview();

  document.getElementById('settings-dialog').classList.add('visible');
}

function closeSettings() {
  document.getElementById('settings-dialog').classList.remove('visible');
  applyAccent(settings.accent);
}

async function applySettings() {
  const draft = readFilterDraft();

  const nextSettings = {
    ...settings,
    accent: draft.accent,
    excludeAbandoned: draft.excludeAbandoned,
    titleFilters: draft.titleFilters,
    authorFilters: draft.authorFilters,
  };

  applyAccent(nextSettings.accent);
  void saveSettings(nextSettings);

  closeSettings();
  fetchStats();   // re-fetch with new filters
}

/* ── Accent picker click handling ──────────────────────────────────────── */
function initAccentPicker() {
  document.getElementById('accent-picker').addEventListener('click', e => {
    const swatch = e.target.closest('.accent-swatch');
    if (!swatch) return;
    swatch.closest('.accent-picker').querySelectorAll('.accent-swatch').forEach(s => s.classList.remove('active'));
    swatch.classList.add('active');
    if (swatch.dataset.reset) {
      settingsDraft.accent = null;
      applyAccent(null);
    } else {
      settingsDraft.accent = swatch.dataset.hex;
      applyAccent(swatch.dataset.hex);
    }
  });
}

/* ── Filter add buttons ────────────────────────────────────────────────── */
function initFilterAddButtons() {
  document.getElementById('title-filter-add').addEventListener('click', () => {
    const container = document.getElementById('title-filter-list');
    container.appendChild(createFilterRow('contains', '', updateFilterPreview));
    updateFilterPreview();
  });
  document.getElementById('author-filter-add').addEventListener('click', () => {
    const container = document.getElementById('author-filter-list');
    container.appendChild(createFilterRow('contains', '', updateFilterPreview));
    updateFilterPreview();
  });
}

/* ── Settings dialog init ──────────────────────────────────────────────── */
function initSettingsDialog() {
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('settings-close').addEventListener('click', closeSettings);
  document.getElementById('settings-cancel').addEventListener('click', closeSettings);
  document.getElementById('settings-apply').addEventListener('click', applySettings);
  document.getElementById('settings-dialog').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeSettings();
  });
  document.getElementById('toggle-exclude-abandoned').addEventListener('change', updateFilterPreview);
}

/* ── Helpers ───────────────────────────────────────────────────────────── */
function fmt(n) { return n == null ? '—' : Number(n).toLocaleString('pt-BR'); }
function fmtHours(secs) {
  if (!secs) return '0h';
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
  return m > 0 ? `${fmt(h)}h ${m}m` : `${fmt(h)}h`;
}
function fmtMinSec(secs) {
  if (!secs) return '—';
  const m = Math.floor(secs / 60), s = Math.round(secs % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ── Animated counter ──────────────────────────────────────────────────── */
function animateValue(el, target, duration = 800, suffix = '') {
  if (!el) return;
  const start = performance.now();
  const isFloat = String(target).includes('.');
  const animate = (now) => {
    const progress = Math.min((now - start) / duration, 1);
    const ease = 1 - Math.pow(1 - progress, 3);
    const current = isFloat ? (target * ease).toFixed(1) : Math.round(target * ease);
    el.textContent = fmt(current) + suffix;
    if (progress < 1) requestAnimationFrame(animate);
    else el.textContent = fmt(target) + suffix;
  };
  requestAnimationFrame(animate);
}

/* ── Status badge ──────────────────────────────────────────────────────── */
function setStatus(type, label) {
  const badge = document.getElementById('status-badge');
  badge.className = `badge badge--${type}`;
  badge.querySelector('.badge-label').textContent = label;
}

function setLoadingState(isLoading) {
  const loading = document.getElementById('loading-state');
  const dashboard = document.getElementById('dashboard');
  loading.classList.toggle('hidden', !isLoading);
  dashboard.classList.toggle('hidden', isLoading);
  document.body.classList.toggle('is-loading', isLoading);
}

/* ── Chart defaults ────────────────────────────────────────────────────── */
const CHART_DEFAULTS = {
  font: { family: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif", size: 11 },
  color: '#96887a',
};
Chart.defaults.color = CHART_DEFAULTS.color;
Chart.defaults.font  = CHART_DEFAULTS.font;

function baseTooltip() {
  return {
    backgroundColor: '#241e19',
    borderColor: 'rgba(243,237,228,0.14)',
    borderWidth: 1,
    titleColor: '#f2ece2',
    bodyColor: '#b6a998',
    padding: 10,
    cornerRadius: 8,
    titleFont: { family: "'Manrope', sans-serif", size: 12, weight: '600' },
    bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
  };
}
function baseGrid() {
  return { color: 'rgba(243,237,228,0.055)', drawBorder: false };
}
function baseTick() {
  return { color: '#96887a', font: { size: 10 } };
}

function destroyChart(key) {
  if (state.charts[key]) { state.charts[key].destroy(); state.charts[key] = null; }
}

/* ── Read accent RGB from CSS variable ─────────────────────────────── */
function getAccentRGB() {
  const val = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim();
  return val || '207, 95, 74';
}

/* ── Monthly chart ─────────────────────────────────────────────────────── */
function renderMonthlyChart() {
  const data = state.monthlyData;
  if (!data.length) return;
  const total = Math.ceil(data.length / state.MONTH_PAGE_SZ);
  const page  = state.monthPage;
  const slice = data.slice(page * state.MONTH_PAGE_SZ, (page + 1) * state.MONTH_PAGE_SZ);

  document.getElementById('label-month-page').textContent = `${page + 1} / ${total}`;
  document.getElementById('btn-prev-month').disabled = page === 0;
  document.getElementById('btn-next-month').disabled = page >= total - 1;

  destroyChart('monthly');
  const ctx = document.getElementById('chart-monthly').getContext('2d');
  state.charts.monthly = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: slice.map(d => d.month),
      datasets: [{
        label: 'Horas',
        data: slice.map(d => d.hours),
        backgroundColor: slice.map(d => `rgba(${getAccentRGB()},${0.35 + 0.55 * (d.hours / Math.max(...data.map(x=>x.hours)||1))})`),
        borderColor: `rgba(${getAccentRGB()},0.7)`,
        borderWidth: 1,
        borderRadius: 4,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { ...baseTooltip(), callbacks: { label: ctx => ` ${ctx.parsed.y.toFixed(1)}h` } } },
      scales: {
        x: { grid: { display: false }, ticks: { ...baseTick(), maxRotation: 45 } },
        y: { grid: baseGrid(), ticks: baseTick(), beginAtZero: true },
      },
    },
  });
}

/* ── Hourly chart ──────────────────────────────────────────────────────── */
function renderHourlyChart(hourly) {
  destroyChart('hourly');
  const ctx = document.getElementById('chart-hourly').getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 200);
  gradient.addColorStop(0,   'rgba(108, 154, 196, 0.35)');
  gradient.addColorStop(1,   'rgba(108, 154, 196, 0.02)');
  state.charts.hourly = new Chart(ctx, {
    type: 'line',
    data: {
      labels: hourly.map(d => d.hour + 'h'),
      datasets: [{
        label: 'Horas',
        data: hourly.map(d => d.hours),
        fill: true, backgroundColor: gradient,
        borderColor: 'rgba(108, 154, 196, 0.8)', borderWidth: 2,
        pointRadius: 0, pointHoverRadius: 4,
        tension: 0.35,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { ...baseTooltip(), callbacks: { label: ctx => ` ${ctx.parsed.y.toFixed(2)}h` } } },
      scales: {
        x: { grid: { display: false }, ticks: { ...baseTick(), maxTicksLimit: 8 } },
        y: { grid: baseGrid(), ticks: baseTick(), beginAtZero: true },
      },
    },
  });
}

/* ── Weekly chart ──────────────────────────────────────────────────────── */
function renderWeeklyChart(weekly) {
  destroyChart('weekly');
  const ctx = document.getElementById('chart-weekly').getContext('2d');
  const max = Math.max(...weekly.map(d => d.hours));
  state.charts.weekly = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: weekly.map(d => d.day),
      datasets: [{
        label: 'Horas',
        data: weekly.map(d => d.hours),
        backgroundColor: weekly.map(d =>
          d.hours === max ? 'rgba(160,143,201,0.75)' : 'rgba(160,143,201,0.3)'),
        borderColor: 'rgba(160,143,201,0.6)',
        borderWidth: 1, borderRadius: 4, borderSkipped: false,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { ...baseTooltip(), callbacks: { label: ctx => ` ${ctx.parsed.x.toFixed(1)}h` } } },
      scales: {
        x: { grid: baseGrid(), ticks: baseTick(), beginAtZero: true },
        y: { grid: { display: false }, ticks: { ...baseTick(), font: { size: 11 } } },
      },
    },
  });
}

/* ── Custom Chart.js plugin: center text for doughnut ─────────────── */
const centerTextPlugin = {
  id: 'centerText',
  afterDraw(chart) {
    const { width, height, ctx, data } = chart;
    ctx.save();
    const total = data.datasets[0].data.reduce((a, b) => a + b, 0);
    if (!total) { ctx.restore(); return; }
    const centerX = width / 2;
    const centerY = height / 2 - 2;

    ctx.font = '700 20px "JetBrains Mono", monospace';
    ctx.fillStyle = '#f2ece2';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(String(total), centerX, centerY - 2);

    ctx.font = '500 11px "Manrope", sans-serif';
    ctx.fillStyle = '#96887a';
    ctx.textBaseline = 'top';
    ctx.fillText('livros', centerX, centerY + 2);
    ctx.restore();
  }
};

/* ── Status donut ──────────────────────────────────────────────────────── */
function renderStatusChart(summary) {
  destroyChart('status');
  const ctx = document.getElementById('chart-status').getContext('2d');
  const { finished_books: fin, reading_books: rdg, abandoned_books: abn } = summary;

  const entries = [
    { label: 'Concluídos', value: fin, color: 'rgba(143,182,126,0.8)', border: 'rgba(143,182,126,0.4)' },
    { label: 'Lendo',      value: rdg, color: 'rgba(108,154,196,0.8)', border: 'rgba(108,154,196,0.4)' },
    { label: 'Pausados',   value: abn, color: 'rgba(110,100,89,0.6)',  border: 'rgba(110,100,89,0.4)' },
  ].filter(e => e.value > 0);

  if (!entries.length) {
    state.charts.status = new Chart(ctx, {
      type: 'doughnut',
      data: { labels: ['Sem dados'], datasets: [{ data: [1], backgroundColor: ['rgba(110,100,89,0.2)'], borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '65%', plugins: { legend: { display: false }, tooltip: { display: false } } },
      plugins: [centerTextPlugin],
    });
    return;
  }

  const total = entries.reduce((s, e) => s + e.value, 0);

  state.charts.status = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: entries.map(e => `${e.label}: ${Math.round((e.value / total) * 100)}%`),
      datasets: [{
        data: entries.map(e => e.value),
        backgroundColor: entries.map(e => e.color),
        borderColor:     entries.map(e => e.border),
        borderWidth: 2,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '65%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { padding: 12, boxWidth: 10, boxHeight: 10, usePointStyle: true },
        },
        tooltip: { ...baseTooltip(), callbacks: { label: ctx => ` ${ctx.parsed} livro${ctx.parsed !== 1 ? 's' : ''}` } },
      },
    },
    plugins: [centerTextPlugin],
  });
}

/* ── Size distribution chart ───────────────────────────────────────────── */
function renderSizeChart(sizeDist) {
  destroyChart('size');
  const filtered = sizeDist.filter(d => d.count > 0);
  if (!filtered.length) {
    document.getElementById('chart-size').parentElement.innerHTML =
      '<p class="empty-chart-msg">Nenhum livro cadastrado.</p>';
    return;
  }
  const ctx = document.getElementById('chart-size').getContext('2d');
  state.charts.size = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: filtered.map(d => d.range),
      datasets: [{
        label: 'Livros',
        data: filtered.map(d => d.count),
        backgroundColor: 'rgba(160,143,201,0.4)',
        borderColor: 'rgba(160,143,201,0.7)',
        borderWidth: 1, borderRadius: 4, borderSkipped: false,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { ...baseTooltip(), callbacks: { label: ctx => ` ${ctx.parsed.y} livros` } } },
      scales: {
        x: { grid: { display: false }, ticks: { ...baseTick(), font: { size: 10 } } },
        y: { grid: baseGrid(), ticks: { ...baseTick(), precision: 0 }, beginAtZero: true },
      },
    },
  });
}

/* ── Heatmap ───────────────────────────────────────────────────────────── */
function getHeatLevel(hours) {
  if (hours <= 0)    return 0;
  if (hours < 0.5)   return 1;
  if (hours < 1.25)  return 2;
  if (hours < 2.5)   return 3;
  return 4;
}

function renderHeatmap(cells) {
  const grid   = document.getElementById('heatmap-grid');
  const months = document.getElementById('heatmap-months');
  grid.innerHTML = '';
  months.innerHTML = '';

  const cols = Math.ceil(cells.length / 7) || 53;
  grid.style.setProperty('--heatmap-cols', cols);
  months.style.setProperty('--heatmap-cols', cols);

  const monthOrder = [];
  let prevMonth = '';
  cells.forEach((cell, idx) => {
    const mo = cell.date.slice(0, 7);
    if (mo !== prevMonth) {
      // ancoramos o rótulo na coluna de semanas onde o mês realmente começa
      monthOrder.push({ mo, startCol: Math.floor(idx / 7) });
      prevMonth = mo;
    }
  });

  monthOrder.forEach(entry => {
    const label = document.createElement('span');
    // constrói a data em hora local — evita o desvio de mês em fusos
    // negativos (new Date('YYYY-MM-01') é interpretado como UTC, virando o mês anterior)
    const [yy, mm] = entry.mo.split('-').map(Number);
    const dt = new Date(yy, mm - 1, 1);
    label.textContent = dt.toLocaleString('pt-BR', { month: 'short' });
    label.style.left = `calc(${entry.startCol} * (var(--heatmap-cell, 14px) + var(--heatmap-gap, 2px)))`;
    months.appendChild(label);
  });

  cells.forEach((cell, idx) => {
    const div = document.createElement('div');
    div.className = 'hm-cell';
    div.style.setProperty('--i', idx);
    div.dataset.level = cell.future ? 'future' : getHeatLevel(cell.hours);
    if (cell.future) div.dataset.future = 'true';
    if (!cell.future) {
      const today = new Date();
      const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      if (cell.date === iso) div.dataset.today = 'true';
    }
    if (!cell.future && cell.hours > 0) {
      const dt = new Date(cell.date + 'T00:00:00');
      const label = dt.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
      div.title = `${label} · ${cell.hours.toFixed(1)}h`;
    } else if (!cell.future) {
      const dt = new Date(cell.date + 'T00:00:00');
      div.title = dt.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
    }
    grid.appendChild(div);
  });

  const yearDays  = cells.filter(c => !c.future && c.hours > 0).length;
  const today     = new Date();
  const d30       = new Date(today); d30.setDate(today.getDate() - 30);
  const hours30d  = cells.filter(c => !c.future && new Date(c.date) >= d30).reduce((s, c) => s + c.hours, 0);

  document.getElementById('hm-stat-year').innerHTML =
    `<strong>${yearDays}</strong> dias de leitura no último ano`;
  document.getElementById('hm-stat-30d').innerHTML =
    `<strong>${hours30d.toFixed(1)}h</strong> lidas nos últimos 30 dias`;

  requestAnimationFrame(() => {
    const scrollWrap = document.querySelector('.heatmap-scroll');
    if (scrollWrap) scrollWrap.scrollLeft = scrollWrap.scrollWidth;
  });
}

function buildTop10Markup(listType, data) {
  if (!data || !data.length) {
    return '<p class="dialog-empty">Nenhum dado disponível.</p>';
  }

  return data.map(item => {
    let label = '';
    switch (listType) {
      case 'longest':
        label = `${fmt(item.pages)} páginas`;
        break;
      case 'mostTime':
        label = `${item.hours}h`;
        break;
      case 'fastest':
      case 'slowest':
        label = `${item.speed_pages_hour} pág/h`;
        break;
    }
    return `<div class="dialog-item"><span>${esc(item.title)} - ${esc(item.author)}</span><span>${label}</span></div>`;
  }).join('');
}

/* ── Authors list ──────────────────────────────────────────────────────── */
function renderAuthors(authors) {
  const el  = document.getElementById('top-authors-list');
  const max = authors[0]?.hours || 1;
  el.innerHTML = authors.map((a, i) => `
    <div class="author-row">
      <span class="author-rank">${i + 1}</span>
      <div class="author-info">
        <div class="author-name">${esc(a.author)}</div>
        <div class="author-meta">${a.books} livro${a.books !== 1 ? 's' : ''}</div>
      </div>
      <div class="author-bar-wrap">
        <div class="author-bar-bg">
          <div class="author-bar-fill" style="width:${Math.round((a.hours/max)*100)}%"></div>
        </div>
        <div class="author-hours">${a.hours.toFixed(1)}h</div>
      </div>
    </div>
  `).join('');
}

/* ── Insights ──────────────────────────────────────────────────────────── */
function renderInsights(ins) {
  document.getElementById('insight-profile').textContent = ins.reader_profile || '—';
  document.getElementById('insight-pref-dow').textContent  = ins.preferred_dow   || '—';
  document.getElementById('insight-pref-hour').textContent = ins.preferred_hour  || '—';

  const lb = ins.longest_book   || {};
  const mt = ins.most_time_book || {};
  const fb = ins.fastest_book   || {};
  const sb = ins.slowest_book   || {};

  document.getElementById('insight-longest-title').textContent  = lb.title  || '—';
  document.getElementById('insight-longest-author').textContent = lb.author || '—';
  document.getElementById('insight-longest-pages').textContent  = lb.pages != null ? `${fmt(lb.pages)} páginas` : '—';

  document.getElementById('insight-time-title').textContent  = mt.title  || '—';
  document.getElementById('insight-time-author').textContent = mt.author || '—';
  document.getElementById('insight-time-hours').textContent  = mt.hours  != null ? `${mt.hours}h` : '—';

  document.getElementById('insight-fastest-title').textContent  = fb.title  || '—';
  document.getElementById('insight-fastest-author').textContent = fb.author || '—';
  document.getElementById('insight-fastest-speed').textContent  = fb.speed_pages_hour != null ? `${fb.speed_pages_hour} pág/h` : '—';

  document.getElementById('insight-slowest-title').textContent  = sb.title  || '—';
  document.getElementById('insight-slowest-author').textContent = sb.author || '—';
  document.getElementById('insight-slowest-speed').textContent  = sb.speed_pages_hour != null ? `${sb.speed_pages_hour} pág/h` : '—';
}

/* ── KPI cards ─────────────────────────────────────────────────────────── */
function renderKPIs(summary, insights) {
  const s = summary;

  const booksEl = document.getElementById('val-total-books');
  animateValue(booksEl, s.total_books);
  document.getElementById('desc-books-split').textContent =
    `${s.reading_books} lendo · ${s.finished_books} lidos · ${s.abandoned_books} pausados`;

  document.getElementById('val-reading-time').textContent = fmtHours(s.total_time_seconds);
  document.getElementById('desc-reading-days').textContent =
    `${fmt(insights.total_reading_days)} dias de atividade`;

  animateValue(document.getElementById('val-pages-read'), s.total_pages_read);
  document.getElementById('desc-avg-page-time').textContent =
    `Média de ${fmtMinSec(s.avg_page_time_seconds)} por página`;

  animateValue(document.getElementById('val-reading-speed'), s.avg_speed_pages_hour, 800);

  animateValue(document.getElementById('val-avg-wpm'), s.avg_wpm, 800);
  document.getElementById('desc-wpm-profile').textContent = s.wpm_profile || '—';

  animateValue(document.getElementById('val-highlights'), s.total_highlights + s.total_notes);
  document.getElementById('desc-highlights-notes').textContent =
    `${fmt(s.total_highlights)} destaques · ${fmt(s.total_notes)} notas`;

  animateValue(document.getElementById('val-current-streak'), insights.current_streak);
  document.getElementById('desc-max-streak').textContent =
    `Recorde: ${fmt(insights.max_streak)} dias`;

  const fi = state._lastFilterInfo || {};
  const banner = document.getElementById('filter-banner');
  const bannerText = document.getElementById('filter-banner-text');
  if (fi.active) {
    banner.classList.remove('hidden');
    const total = fi.total_after_filter;
    bannerText.textContent = `Filtros ativos: ${total} livro${total !== 1 ? 's' : ''} exibido${total !== 1 ? 's' : ''}`;
  } else {
    banner.classList.add('hidden');
  }
}

/* ── Books table ───────────────────────────────────────────────────────── */
const STATUS_LABELS = { reading: 'Lendo', finished: 'Concluído', abandoned: 'Pausado' };

function applyBookFilters() {
  let list = state.books.slice();
  if (state.filter !== 'all') list = list.filter(b => b.status === state.filter);
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    list = list.filter(b =>
      b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q));
  }
  if (state.sortCol) {
    const col = state.sortCol, dir = state.sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      let va = a[col], vb = b[col];
      if (typeof va === 'string') return va.localeCompare(vb) * dir;
      return (va - vb) * dir;
    });
  }
  state.booksFiltered = list;
  renderBooksTable();
}

function renderBooksTable() {
  const tbody = document.getElementById('books-tbody');
  const empty = document.getElementById('books-empty');
  const list  = state.booksFiltered;

  if (!list.length) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  tbody.innerHTML = list.map(b => {
    const pctFill = Math.min(100, b.progress);
    const pctColor = b.status === 'finished' ? '#8fb67e' : b.status === 'reading' ? '#7a9fc4' : '#6e6459';

    let pagesDisplay;
    if (b.has_real_pages && b.real_pages != null) {
      pagesDisplay = `<span class="rp-indicator" title="Páginas reais via Hardcover">${fmt(b.real_pages)}</span>`;
    } else if (b.pages > 0) {
      pagesDisplay = `${fmt(b.pages)}<span class="rp-missing" title="Sem páginas reais — clique para buscar">*</span>`;
    } else {
      pagesDisplay = `<span class="rp-missing" title="Sem páginas reais — clique para buscar">—*</span>`;
    }

    return `
    <tr>
      <td>
        <div class="book-title-cell">
          <span class="title">${esc(b.title)}</span>
          <span class="author">${esc(b.author)}</span>
        </div>
      </td>
      <td>
        <div class="progress-cell">
          <span class="status-badge ${b.status}">${STATUS_LABELS[b.status]}</span>
          <div class="progress-row" style="margin-top:5px">
            <div class="progress-bar-bg">
              <div class="progress-bar-fill" style="width:${pctFill}%;background:${pctColor}"></div>
            </div>
            <span class="progress-pct">${b.progress}%</span>
          </div>
        </div>
      </td>
      <td class="mono pages-cell" data-md5="${esc(b.md5 || '')}" data-title="${esc(b.title)}" data-author="${esc(b.author)}">${pagesDisplay}</td>
      <td class="mono">${b.reading_days > 0 ? fmt(b.reading_days) : '—'}</td>
      <td class="mono">${b.time_hours > 0 ? b.time_hours + 'h' : '—'}</td>
      <td class="mono">${b.speed_pages_hour > 0 ? b.speed_pages_hour + ' p/h' : '—'}</td>
      <td class="mono">${b.wpm > 0 ? b.wpm + ' p/min' : '—'}</td>
      <td class="mono">${(b.highlights + b.notes) > 0 ? fmt(b.highlights + b.notes) : '—'}</td>
      <td class="mono">${esc(b.last_open)}</td>
    </tr>`;
  }).join('');
}

/* ── Table sort ────────────────────────────────────────────────────────── */
function initTableSort() {
  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (state.sortCol === col) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortCol = col;
        state.sortDir = 'desc';
      }
      document.querySelectorAll('th.sortable').forEach(t => {
        t.classList.remove('sort-active');
        t.querySelector('.sort-icon').textContent = '↕';
      });
      th.classList.add('sort-active');
      th.querySelector('.sort-icon').textContent = state.sortDir === 'asc' ? '↑' : '↓';
      applyBookFilters();
    });
  });
}

/* ── Filter tabs ───────────────────────────────────────────────────────── */
function initFilterTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.filter = btn.dataset.filter;
      applyBookFilters();
    });
  });
}

/* ── Search ────────────────────────────────────────────────────────────── */
function initSearch() {
  const input = document.getElementById('search-books');
  input.addEventListener('input', debounce(e => {
    state.searchQuery = e.target.value.trim();
    applyBookFilters();
  }, 250));
}

/* ── Month pagination ──────────────────────────────────────────────────── */
function initMonthNav() {
  document.getElementById('btn-prev-month').addEventListener('click', () => {
    if (state.monthPage > 0) { state.monthPage--; renderMonthlyChart(); }
  });
  document.getElementById('btn-next-month').addEventListener('click', () => {
    const total = Math.ceil(state.monthlyData.length / state.MONTH_PAGE_SZ);
    if (state.monthPage < total - 1) { state.monthPage++; renderMonthlyChart(); }
  });
}

/* ── Main data load ────────────────────────────────────────────────────── */
async function fetchStats() {
  const btn = document.getElementById('btn-refresh');
  btn.classList.add('spinning');
  setStatus('loading', 'Carregando…');
  setLoadingState(true);

  try {
    const filtersObj = buildFiltersJSON(settings);
    let url = API.stats;
    if (filtersObj) {
      url += '?filters=' + encodeURIComponent(JSON.stringify(filtersObj));
    }

    const headers = {};
    if (state.etag) {
      headers['If-None-Match'] = state.etag;
    }

    const res  = await fetch(url, { headers });

    if (res.status === 304) {
      setStatus('ok', 'Banco OK');
      btn.classList.remove('spinning');
      setLoadingState(false);
      return;
    }

    const data = await res.json();
    state.etag = res.headers.get('ETag') || state.etag;

    if (data.error) {
      document.getElementById('error-banner').classList.remove('hidden');
      document.getElementById('error-msg').textContent = data.error;
      document.getElementById('dashboard').classList.add('hidden');
      document.getElementById('loading-state').classList.add('hidden');
      setStatus('err', 'Erro');
      return;
    }

    document.getElementById('error-banner').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');
    document.getElementById('loading-state').classList.add('hidden');

    const { summary, insights, charts, heatmap, top_authors, books, filter_info } = data;

    lastFetchData = data;
    state._lastFilterInfo = filter_info || {};

    state.books       = books;
    state.monthlyData = charts.monthly;
    state.monthPage   = Math.max(0, Math.ceil(charts.monthly.length / state.MONTH_PAGE_SZ) - 1);
    state.topLists = {
        longest: insights.top10_longest || [],
        mostTime: insights.top10_most_time || [],
        fastest: insights.top10_fastest || [],
        slowest: insights.top10_slowest || []
    };
    state.topListMarkup = {
      longest: buildTop10Markup('longest', state.topLists.longest),
      mostTime: buildTop10Markup('mostTime', state.topLists.mostTime),
      fastest: buildTop10Markup('fastest', state.topLists.fastest),
      slowest: buildTop10Markup('slowest', state.topLists.slowest),
    };

    renderKPIs(summary, insights);
    renderInsights(insights);
    renderHeatmap(heatmap);
    renderAuthors(top_authors);
    renderMonthlyChart();
    renderHourlyChart(charts.hourly);
    renderWeeklyChart(charts.weekly);
    renderStatusChart(summary);
    renderSizeChart(charts.size_distribution);

    applyBookFilters();
    updateAbandonedTab();

    const now = new Date();
    document.getElementById('footer-sync').innerHTML =
      `Atualizado às <strong>${now.toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'})}</strong>`;

    setStatus('ok', 'Banco OK');
    state.lastDbMtime = data._mtime || 0;

  } catch (err) {
    console.error(err);
    setStatus('err', 'Sem conexão');
    document.getElementById('loading-state').classList.add('hidden');
  } finally {
    btn.classList.remove('spinning');
    setLoadingState(false);
  }
}

/* ── Polling for DB changes ────────────────────────────────────────────── */
async function checkDbStatus() {
  try {
    const res  = await fetch(API.status);
    const data = await res.json();
    if (!data.exists) {
      setStatus('warn', 'DB ausente');
      return;
    }
    if (state.lastDbMtime && data.modified > state.lastDbMtime) {
      state.lastDbMtime = data.modified;
      fetchStats();
    }
  } catch { /* silent */ }
}

/* ── Dialog functions ───────────────────────────────────────────────────── */
function showTop10List(listType) {
    const dialog = document.getElementById('top10-dialog');
    const titleEl = document.getElementById('dialog-title');
    const listEl = document.getElementById('dialog-list');

    const titles = {
        longest: 'Top 10 Livros Mais Longos',
        mostTime: 'Top 10 Livros com Mais Tempo Dedicado',
        fastest: 'Top 10 Leituras Mais Rápidas',
        slowest: 'Top 10 Leituras Mais Cadenciadas'
    };

    titleEl.textContent = titles[listType] || 'Top 10';
    listEl.innerHTML = state.topListMarkup[listType] || '<p class="dialog-empty">Nenhum dado disponível.</p>';
    document.body.classList.add('overlay-open');
    dialog.classList.add('visible');
}

function hideTop10List() {
    document.getElementById('top10-dialog').classList.remove('visible');
    document.body.classList.remove('overlay-open');
}

/* ── Real Pages Dialog ──────────────────────────────────────────────────── */
let rpCurrentBook = null;

function openRealPagesDialog(bookMd5, bookTitle, bookAuthor) {
  rpCurrentBook = { md5: bookMd5, title: bookTitle, author: bookAuthor };
  const info = document.getElementById('realpages-book-info');
  info.innerHTML = `<strong>${esc(bookTitle)}</strong><span class="rp-author">${esc(bookAuthor)}</span>`;
  document.getElementById('realpages-search-input').value = bookTitle + (bookAuthor ? ' ' + bookAuthor : '');
  document.getElementById('realpages-results').innerHTML = '';
  document.getElementById('realpages-error').classList.add('hidden');
  document.getElementById('realpages-loading').classList.add('hidden');
  document.getElementById('realpages-manual-input').value = '';
  document.getElementById('realpages-manual-btn').disabled = false;
  document.getElementById('realpages-manual-btn').textContent = 'Salvar';
  document.body.classList.add('overlay-open');
  document.getElementById('realpages-dialog').classList.add('visible');
  document.getElementById('realpages-search-input').focus();
  document.getElementById('realpages-search-input').select();
}

function closeRealPagesDialog() {
  document.getElementById('realpages-dialog').classList.remove('visible');
  document.body.classList.remove('overlay-open');
  rpCurrentBook = null;
}

async function searchRealPages() {
  const input = document.getElementById('realpages-search-input');
  const title = input.value.trim();
  if (!title) return;
  const author = rpCurrentBook?.author || '';

  const loading = document.getElementById('realpages-loading');
  const error = document.getElementById('realpages-error');
  const results = document.getElementById('realpages-results');
  error.classList.add('hidden');
  results.innerHTML = '';
  loading.classList.remove('hidden');

  try {
    const res = await fetch(API.realPages + '/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, author }),
    });
    const data = await res.json();
    loading.classList.add('hidden');

    if (data.error) {
      error.textContent = 'Erro: ' + data.error;
      error.classList.remove('hidden');
      return;
    }

    if (!data.results || !data.results.length) {
      results.innerHTML = '<p class="dialog-empty">Nenhum resultado encontrado.</p>';
      return;
    }

    let html = '';
    for (const book of data.results) {
      html += `<div class="rp-book-group">`;
      html += `<div class="rp-book-title">${esc(book.book_title)}</div>`;
      if (book.authors && book.authors.length) {
        html += `<div class="rp-book-authors">${esc(book.authors.join(', '))}</div>`;
      }
      html += `<div class="rp-editions">`;
      for (const ed of book.editions) {
        const pages = ed.pages != null ? `${ed.pages} páginas` : 'páginas não informadas';
        const lang = ed.language ? ` · ${ed.language}` : '';
        const fmtInfo = ed.format ? `${ed.format}` : '';
        html += `
          <div class="rp-edition">
            <div class="rp-edition-info">
              <span class="rp-edition-pages">${pages}</span>
              <span class="rp-edition-meta">${esc(fmtInfo)}${lang}</span>
              ${ed.isbn_13 ? `<span class="rp-edition-isbn">ISBN: ${ed.isbn_13}</span>` : ''}
            </div>
            <button class="rp-select-btn" data-pages="${ed.pages != null ? ed.pages : ''}" data-edition-id="${esc(ed.id)}" data-book-id="${esc(book.book_id)}">Selecionar</button>
          </div>`;
      }
      html += `</div></div>`;
    }
    results.innerHTML = html;

    // Add click handlers for select buttons
    results.querySelectorAll('.rp-select-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const pages = btn.dataset.pages;
        if (!pages) {
          error.textContent = 'Esta edição não tem número de páginas.';
          error.classList.remove('hidden');
          return;
        }
        btn.disabled = true;
        btn.textContent = 'Salvando…';
        const saveRes = await fetch(API.realPages + '/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            md5: rpCurrentBook.md5,
            pages: parseInt(pages),
            title: rpCurrentBook.title,
            author: rpCurrentBook.author,
            edition_id: btn.dataset.editionId,
            book_id: btn.dataset.bookId,
          }),
        });
        const saveData = await saveRes.json();
        if (saveData.ok) {
          closeRealPagesDialog();
          fetchStats();
        } else {
          error.textContent = 'Erro ao salvar: ' + (saveData.error || 'desconhecido');
          error.classList.remove('hidden');
          btn.disabled = false;
          btn.textContent = 'Selecionar';
        }
      });
    });
  } catch (err) {
    loading.classList.add('hidden');
    error.textContent = 'Erro de conexão: ' + err.message;
    error.classList.remove('hidden');
  }
}

function initRealPagesDialog() {
  document.getElementById('realpages-close').addEventListener('click', closeRealPagesDialog);
  document.getElementById('realpages-cancel').addEventListener('click', closeRealPagesDialog);
  document.getElementById('realpages-dialog').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeRealPagesDialog();
  });
  document.getElementById('realpages-search-btn').addEventListener('click', searchRealPages);
  document.getElementById('realpages-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchRealPages();
  });

  // Manual save
  document.getElementById('realpages-manual-btn').addEventListener('click', async () => {
    const input = document.getElementById('realpages-manual-input');
    const pages = parseInt(input.value);
    if (!pages || pages < 1) {
      document.getElementById('realpages-error').textContent = 'Informe um número válido de páginas.';
      document.getElementById('realpages-error').classList.remove('hidden');
      return;
    }
    if (!rpCurrentBook) return;
    const btn = document.getElementById('realpages-manual-btn');
    btn.disabled = true;
    btn.textContent = 'Salvando…';
    const res = await fetch(API.realPages + '/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        md5: rpCurrentBook.md5,
        pages,
        title: rpCurrentBook.title,
        author: rpCurrentBook.author,
        edition_id: '',
        book_id: '',
      }),
    });
    const data = await res.json();
    if (data.ok) {
      closeRealPagesDialog();
      fetchStats();
    } else {
      document.getElementById('realpages-error').textContent = 'Erro ao salvar: ' + (data.error || 'desconhecido');
      document.getElementById('realpages-error').classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Salvar';
    }
  });
  document.getElementById('realpages-manual-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('realpages-manual-btn').click();
  });

  // Delegate click on pages cells in the books table
  document.getElementById('books-tbody').addEventListener('click', (e) => {
    const cell = e.target.closest('.pages-cell');
    if (!cell) return;
    const md5 = cell.dataset.md5;
    const title = cell.dataset.title;
    const author = cell.dataset.author;
    if (md5) {
      openRealPagesDialog(md5, title, author);
    }
  });
}

/* ── Batch Real Pages Search (interactive) ────────────────────────────── */
let batchQueue = [];
let batchCurrentIdx = 0;

function renderBatchEditions(results, onSelect) {
  if (!results || !results.length) {
    return '<p class="dialog-empty">Nenhum resultado encontrado no Hardcover.</p>';
  }
  let html = '';
  for (const book of results) {
    html += `<div class="rp-book-group">`;
    html += `<div class="rp-book-title">${esc(book.book_title)}</div>`;
    if (book.authors && book.authors.length) {
      html += `<div class="rp-book-authors">${esc(book.authors.join(', '))}</div>`;
    }
    html += `<div class="rp-editions">`;
    for (const ed of book.editions) {
      const pages = ed.pages != null ? `${ed.pages} páginas` : 'páginas não informadas';
      const lang = ed.language ? ` · ${ed.language}` : '';
      const fmtInfo = ed.format ? `${ed.format}` : '';
      html += `
        <div class="rp-edition">
          <div class="rp-edition-info">
            <span class="rp-edition-pages">${pages}</span>
            <span class="rp-edition-meta">${esc(fmtInfo)}${lang}</span>
            ${ed.isbn_13 ? `<span class="rp-edition-isbn">ISBN: ${ed.isbn_13}</span>` : ''}
          </div>
          <button class="rp-select-btn batch-select-edition" data-pages="${ed.pages != null ? ed.pages : ''}" data-edition-id="${esc(ed.id)}" data-book-id="${esc(book.book_id)}">Selecionar</button>
        </div>`;
    }
    html += `</div></div>`;
  }
  return html;
}

async function batchLoadNext() {
  if (batchCurrentIdx >= batchQueue.length) {
    // Done
    document.getElementById('batch-loading').classList.add('hidden');
    document.getElementById('batch-results').innerHTML = '<p class="dialog-empty batch-done">Busca em lote concluída!</p>';
    document.getElementById('batch-skip-btn').disabled = true;
    document.getElementById('batch-progress').textContent = 'Concluído';
    fetchStats();
    return;
  }

  const book = batchQueue[batchCurrentIdx];
  document.getElementById('batch-idx').textContent = batchCurrentIdx + 1;
  document.getElementById('batch-total').textContent = batchQueue.length;
  document.getElementById('batch-book-info').innerHTML =
    `<strong>${esc(book.title)}</strong><span class="rp-author">${esc(book.author)}</span>`;
  document.getElementById('batch-loading').classList.remove('hidden');
  document.getElementById('batch-results').innerHTML = '';
  document.getElementById('batch-error').classList.add('hidden');
  document.getElementById('batch-skip-btn').disabled = false;

  try {
    const res = await fetch(API.realPages + '/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: book.title, author: book.author }),
    });
    const data = await res.json();
    document.getElementById('batch-loading').classList.add('hidden');

    if (data.error) {
      document.getElementById('batch-error').textContent = 'Erro: ' + data.error;
      document.getElementById('batch-error').classList.remove('hidden');
      return;
    }

    const resultsEl = document.getElementById('batch-results');
    resultsEl.innerHTML = renderBatchEditions(data.results);

    // Attach click handlers
    resultsEl.querySelectorAll('.batch-select-edition').forEach(btn => {
      btn.addEventListener('click', async () => {
        const pages = btn.dataset.pages;
        if (!pages) {
          document.getElementById('batch-error').textContent = 'Esta edição não tem número de páginas.';
          document.getElementById('batch-error').classList.remove('hidden');
          return;
        }
        btn.disabled = true;
        btn.textContent = 'Salvando…';
        const saveRes = await fetch(API.realPages + '/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            md5: book.md5,
            pages: parseInt(pages),
            title: book.title,
            author: book.author,
            edition_id: btn.dataset.editionId,
            book_id: btn.dataset.bookId,
          }),
        });
        const saveData = await saveRes.json();
        if (saveData.ok) {
          batchCurrentIdx++;
          batchLoadNext();
        } else {
          document.getElementById('batch-error').textContent = 'Erro ao salvar: ' + (saveData.error || 'desconhecido');
          document.getElementById('batch-error').classList.remove('hidden');
          btn.disabled = false;
          btn.textContent = 'Selecionar';
        }
      });
    });
  } catch (err) {
    document.getElementById('batch-loading').classList.add('hidden');
    document.getElementById('batch-error').textContent = 'Erro de conexão: ' + err.message;
    document.getElementById('batch-error').classList.remove('hidden');
  }
}

function openBatchDialog() {
  // Get books without real pages from current state
  batchQueue = (state.books || []).filter(b => !b.has_real_pages && b.md5);
  batchCurrentIdx = 0;

  if (!batchQueue.length) {
    const btn = document.getElementById('btn-batch-realpages');
    const origText = btn.textContent;
    btn.textContent = 'Nenhum livro pendente';
    btn.disabled = true;
    setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 2000);
    return;
  }

  document.body.classList.add('overlay-open');
  document.getElementById('batch-dialog').classList.add('visible');
  document.getElementById('batch-skip-btn').disabled = false;
  batchLoadNext();
}

function closeBatchDialog() {
  document.getElementById('batch-dialog').classList.remove('visible');
  document.body.classList.remove('overlay-open');
}

function initBatchSearch() {
  document.getElementById('btn-batch-realpages').addEventListener('click', openBatchDialog);
  document.getElementById('batch-close').addEventListener('click', closeBatchDialog);
  document.getElementById('batch-stop-btn').addEventListener('click', closeBatchDialog);
  document.getElementById('batch-dialog').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeBatchDialog();
  });
  document.getElementById('batch-skip-btn').addEventListener('click', () => {
    batchCurrentIdx++;
    batchLoadNext();
  });
}

/* ── Init ──────────────────────────────────────────────────────────────── */
async function init() {
  // Load persistent settings
  await loadSettings();
  applyAccent(settings.accent);

  // Init UI
  initTableSort();
  initFilterTabs();
  initSearch();
  initMonthNav();
  initAccentPicker();
  initFilterAddButtons();
  initSettingsDialog();
  initRealPagesDialog();
  initBatchSearch();

  // Cards de "Descobertas" abrem o Top 10 — acessíveis por teclado
  document.querySelectorAll('.insight-card[data-list]').forEach(card => {
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        showTop10List(card.dataset.list);
      }
    });
  });

  document.getElementById('btn-refresh').addEventListener('click', fetchStats);
  document.getElementById('dialog-close').addEventListener('click', hideTop10List);
  document.getElementById('top10-dialog').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) hideTop10List();
  });

  setLoadingState(true);
  fetchStats();
  setInterval(checkDbStatus, 15_000);
}

document.addEventListener('DOMContentLoaded', init);
