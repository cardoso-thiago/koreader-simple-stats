/* ═══════════════════════════════════════════════════════════════════════
   KOReader Estante — Frontend
   ═══════════════════════════════════════════════════════════════════════ */

const API = {
  stats:  '/api/stats',
  status: '/api/status',
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
  charts:        {},
  topLists:      {},
};

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

/* ── Chart defaults ────────────────────────────────────────────────────── */
const CHART_DEFAULTS = {
  font: { family: "'JetBrains Mono', monospace", size: 11 },
  color: '#46546a',
};
Chart.defaults.color = CHART_DEFAULTS.color;
Chart.defaults.font  = CHART_DEFAULTS.font;

function baseTooltip() {
  return {
    backgroundColor: '#1a2030',
    borderColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    titleColor: '#f0f4f8',
    bodyColor: '#8898b4',
    padding: 10,
    cornerRadius: 6,
    titleFont: { family: "'DM Sans', sans-serif", size: 12, weight: '600' },
    bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
  };
}
function baseGrid() {
  return {
    color: 'rgba(255,255,255,0.04)',
    drawBorder: false,
  };
}
function baseTick() {
  return { color: '#46546a', font: { size: 10 } };
}

function destroyChart(key) {
  if (state.charts[key]) { state.charts[key].destroy(); state.charts[key] = null; }
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
        backgroundColor: slice.map(d => `rgba(212,168,83,${0.35 + 0.55 * (d.hours / Math.max(...data.map(x=>x.hours)||1))})`),
        borderColor: 'rgba(212,168,83,0.7)',
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
  gradient.addColorStop(0,   'rgba(91,156,245,0.35)');
  gradient.addColorStop(1,   'rgba(91,156,245,0.02)');
  state.charts.hourly = new Chart(ctx, {
    type: 'line',
    data: {
      labels: hourly.map(d => d.hour + 'h'),
      datasets: [{
        label: 'Horas',
        data: hourly.map(d => d.hours),
        fill: true, backgroundColor: gradient,
        borderColor: 'rgba(91,156,245,0.8)', borderWidth: 2,
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
          d.hours === max ? 'rgba(167,139,250,0.75)' : 'rgba(167,139,250,0.3)'),
        borderColor: 'rgba(167,139,250,0.6)',
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

/* ── Status donut ──────────────────────────────────────────────────────── */
function renderStatusChart(summary) {
  destroyChart('status');
  const ctx = document.getElementById('chart-status').getContext('2d');
  const { finished_books: fin, reading_books: rdg, abandoned_books: abn } = summary;
  state.charts.status = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Concluídos', 'Lendo', 'Pausados'],
      datasets: [{
        data: [fin, rdg, abn],
        backgroundColor: ['rgba(74,222,128,0.8)', 'rgba(91,156,245,0.8)', 'rgba(70,84,106,0.6)'],
        borderColor:     ['rgba(74,222,128,0.4)', 'rgba(91,156,245,0.4)', 'rgba(70,84,106,0.4)'],
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
        tooltip: { ...baseTooltip(), callbacks: { label: ctx => ` ${ctx.label}: ${ctx.parsed}` } },
      },
    },
  });
}

/* ── Size distribution chart ───────────────────────────────────────────── */
function renderSizeChart(sizeDist) {
  destroyChart('size');
  const ctx = document.getElementById('chart-size').getContext('2d');
  state.charts.size = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: sizeDist.map(d => d.range),
      datasets: [{
        label: 'Livros',
        data: sizeDist.map(d => d.count),
        backgroundColor: 'rgba(167,139,250,0.4)',
        borderColor: 'rgba(167,139,250,0.7)',
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

  // Compute column widths for month labels
  const CELL = 13; // 11px + 2px gap
  let currentMonth = null;
  let monthCols = {};

  cells.forEach((cell, i) => {
    const col = Math.floor(i / 7);
    const mo  = cell.date.slice(0, 7);
    if (!monthCols[mo]) monthCols[mo] = { start: col, end: col };
    else monthCols[mo].end = col;
  });

  // Month label row
  let prevEnd = -1;
  Object.entries(monthCols).forEach(([mo, { start, end }]) => {
    if (start <= prevEnd) start = prevEnd + 1;
    const gap = start - (prevEnd + 1);
    if (gap > 0) {
      const spacer = document.createElement('span');
      spacer.style.minWidth = `${gap * CELL}px`;
      months.appendChild(spacer);
    }
    const label = document.createElement('span');
    const dt = new Date(mo + '-01');
    label.textContent = dt.toLocaleString('pt-BR', { month: 'short' });
    label.style.minWidth = `${(end - start + 1) * CELL}px`;
    months.appendChild(label);
    prevEnd = end;
  });

  // Cells
  cells.forEach(cell => {
    const div = document.createElement('div');
    div.className = 'hm-cell';
    div.dataset.level = cell.future ? 'future' : getHeatLevel(cell.hours);
    if (cell.future) div.dataset.future = 'true';
    if (!cell.future && cell.hours > 0) {
      const dt = new Date(cell.date + 'T00:00:00');
      const label = dt.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' });
      div.title = `${label} · ${cell.hours.toFixed(1)}h`;
    } else if (!cell.future) {
      const dt = new Date(cell.date + 'T00:00:00');
      div.title = dt.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
    }
    grid.appendChild(div);
  });

  // Stats
  const yearDays  = cells.filter(c => !c.future && c.hours > 0).length;
  const today     = new Date();
  const d30       = new Date(today); d30.setDate(today.getDate() - 30);
  const hours30d  = cells.filter(c => !c.future && new Date(c.date) >= d30).reduce((s, c) => s + c.hours, 0);

  document.getElementById('hm-stat-year').innerHTML =
    `<strong>${yearDays}</strong> dias de leitura no último ano`;
  document.getElementById('hm-stat-30d').innerHTML =
    `<strong>${hours30d.toFixed(1)}h</strong> lidas nos últimos 30 dias`;
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

  // Animate total books
  const booksEl = document.getElementById('val-total-books');
  animateValue(booksEl, s.total_books);
  document.getElementById('desc-books-split').textContent =
    `${s.reading_books} lendo · ${s.finished_books} lidos · ${s.abandoned_books} pausados`;

  // Time
  document.getElementById('val-reading-time').textContent = fmtHours(s.total_time_seconds);
  document.getElementById('desc-reading-days').textContent =
    `${fmt(insights.total_reading_days)} dias de atividade`;

  // Pages
  animateValue(document.getElementById('val-pages-read'), s.total_pages_read);
  document.getElementById('desc-avg-page-time').textContent =
    `Média de ${fmtMinSec(s.avg_page_time_seconds)} por página`;

  // Speed
  animateValue(document.getElementById('val-reading-speed'), s.avg_speed_pages_hour, 800);

  // Highlights
  animateValue(document.getElementById('val-highlights'), s.total_highlights + s.total_notes);
  document.getElementById('desc-highlights-notes').textContent =
    `${fmt(s.total_highlights)} destaques · ${fmt(s.total_notes)} notas`;

  // Streak
  animateValue(document.getElementById('val-current-streak'), insights.current_streak);
  document.getElementById('desc-max-streak').textContent =
    `Recorde: ${fmt(insights.max_streak)} dias`;
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
    const pctColor = b.status === 'finished' ? '#4ade80' : b.status === 'reading' ? '#5b9cf5' : '#46546a';
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
      <td class="mono">${b.pages > 0 ? fmt(b.pages) : '—'}</td>
      <td class="mono">${b.reading_days > 0 ? fmt(b.reading_days) : '—'}</td>
      <td class="mono">${b.time_hours > 0 ? b.time_hours + 'h' : '—'}</td>
      <td class="mono">${b.speed_pages_hour > 0 ? b.speed_pages_hour + ' p/h' : '—'}</td>
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

  try {
    const res  = await fetch(API.stats);
    const data = await res.json();

    if (data.error) {
      document.getElementById('error-banner').classList.remove('hidden');
      document.getElementById('error-msg').textContent = data.error;
      document.getElementById('dashboard').classList.add('hidden');
      setStatus('err', 'Erro');
      return;
    }

    document.getElementById('error-banner').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');

    const { summary, insights, charts, heatmap, top_authors, books } = data;

    // Store and render
    state.books       = books;
    state.monthlyData = charts.monthly;
    state.monthPage   = Math.max(0, Math.ceil(charts.monthly.length / state.MONTH_PAGE_SZ) - 1);
    state.topLists = {
        longest: insights.top10_longest || [],
        mostTime: insights.top10_most_time || [],
        fastest: insights.top10_fastest || [],
        slowest: insights.top10_slowest || []
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

    state.filter      = 'all';
    state.searchQuery = '';
    state.sortCol     = null;
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));
    applyBookFilters();

    // Footer sync time
    const now = new Date();
    document.getElementById('footer-sync').innerHTML =
      `Atualizado às <strong>${now.toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'})}</strong>`;

    setStatus('ok', 'Banco OK');

    // Store DB mtime for polling
    state.lastDbMtime = data._mtime || 0;

  } catch (err) {
    console.error(err);
    setStatus('err', 'Sem conexão');
  } finally {
    btn.classList.remove('spinning');
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

    let data = [];
    switch(listType) {
        case 'longest':  data = state.topLists.longest; break;
        case 'mostTime': data = state.topLists.mostTime; break;
        case 'fastest':  data = state.topLists.fastest; break;
        case 'slowest':  data = state.topLists.slowest; break;
    }

    if (data.length === 0) {
        listEl.innerHTML = '<p class="dialog-empty">Nenhum dado disponível.</p>';
    } else {
        listEl.innerHTML = data.map((item, index) => {
            let label = '';
            switch(listType) {
                case 'longest':  label = `${fmt(item.pages)} páginas`; break;
                case 'mostTime': label = `${item.hours}h`; break;
                case 'fastest':  label = `${item.speed_pages_hour} pág/h`; break;
                case 'slowest':  label = `${item.speed_pages_hour} pág/h`; break;
            }
            return `<div class="dialog-item"><span>${item.title} - ${item.author}</span><span>${label}</span></div>`;
        }).join('');
    }

    dialog.classList.add('visible');
}

function hideTop10List() {
    document.getElementById('top10-dialog').classList.remove('visible');
}

/* ── Init ──────────────────────────────────────────────────────────────── */
function init() {
  initTableSort();
  initFilterTabs();
  initSearch();
  initMonthNav();

  document.getElementById('btn-refresh').addEventListener('click', fetchStats);
  document.getElementById('dialog-close').addEventListener('click', hideTop10List);
  document.getElementById('top10-dialog').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) hideTop10List();
  });

  fetchStats();
  setInterval(checkDbStatus, 15_000);
}

document.addEventListener('DOMContentLoaded', init);
