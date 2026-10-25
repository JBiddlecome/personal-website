let allItems = [];
let allReceipts = [];
let allProducts = [];
let departments = [];
let currentChart = null;
let spendChart = null;
let sortBy = 'count';
let sortDir = 'desc';

// ── API ───────────────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
    const res = await fetch(`/grocery/api${path}`, {
        credentials: 'same-origin',
        ...opts,
        headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    });
    if (res.status === 401) { location.reload(); throw new Error('Signed out'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
    return data;
}

async function loadData() {
    try {
        const [items, receipts, vocab] = await Promise.all([api('/items'), api('/receipts'), api('/vocab')]);
        allItems = items.items;
        allReceipts = receipts.receipts;
        departments = vocab.departments;
        document.getElementById('item-basic-list').innerHTML =
            vocab.item_basics.map(v => `<option value="${esc(v.item_basic)}">`).join('');
        refreshAll();
    } catch (err) {
        document.getElementById('product-body').innerHTML =
            `<tr><td colspan="6" class="loading-msg">Could not load data: ${esc(err.message)}</td></tr>`;
    }
}

function refreshAll() {
    allProducts = buildProducts(allItems);
    populateDeptFilter(allProducts);
    computeStats();
    applyFilters();
    renderReceipts();
    if (spendChart) { spendChart.destroy(); spendChart = null; }
    if (!document.getElementById('tab-spending').classList.contains('hidden')) initSpending();
}

// ── Data processing ───────────────────────────────────────────────────────────

// Units bought on one line: a count for "each" items, one purchase for weighed items.
const unitsOf = i => (i.unit === 'each' ? i.quantity : 1);

function buildProducts(items) {
    const map = {};
    for (const i of items) {
        const name = i.item_basic;
        if (!map[name]) map[name] = { name, dept: i.department, count: 0, spend: 0, weighted: 0, prices: [], purchases: [] };
        const p = map[name];
        const units = unitsOf(i);
        p.count += units;
        p.spend += i.line_total;
        p.weighted += i.unit_price * units;
        p.prices.push(i.unit_price);
        p.purchases.push(i);
    }
    return Object.values(map).map(p => {
        p.purchases.sort((a, b) => a.date.localeCompare(b.date));
        const last = p.purchases.at(-1);
        return { ...p, avg: p.weighted / p.count, min: Math.min(...p.prices), max: Math.max(...p.prices), last: last.unit_price, lastItem: last };
    });
}

function init() {
    document.getElementById('search').addEventListener('input', applyFilters);
    document.getElementById('dept-filter').addEventListener('change', applyFilters);
    document.getElementById('back-btn').addEventListener('click', goBack);
    document.querySelectorAll('.th-sortable').forEach(th => th.addEventListener('click', () => toggleSort(th.dataset.sort)));
    TABS.forEach(t => document.getElementById(`nav-${t}`).addEventListener('click', () => switchTab(t)));
    document.getElementById('logout-btn').addEventListener('click', async () => {
        await fetch('/grocery/api/logout', { method: 'POST' });
        location.reload();
    });
    document.getElementById('receipt-file').addEventListener('change', onReceiptFiles);
    document.getElementById('rv-cancel').addEventListener('click', closeReview);
    document.getElementById('rv-save').addEventListener('click', saveReview);
    initDeals();
    loadData();
}

function computeStats() {
    const units = allItems.reduce((s, i) => s + unitsOf(i), 0);
    const spend = allReceipts.reduce((s, r) => s + (r.total ?? r.items_total), 0);
    const saved = allItems.reduce((s, i) => s + (i.savings || 0), 0);
    document.getElementById('stat-total-purchases').textContent = Math.round(units).toLocaleString();
    document.getElementById('stat-total-spend').textContent = `$${spend.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    document.getElementById('stat-total-savings').textContent = money(saved);
}

function toggleSort(field) {
    if (sortBy === field) sortDir = sortDir === 'desc' ? 'asc' : 'desc';
    else { sortBy = field; sortDir = 'desc'; }
    applyFilters();
}

function applyFilters() {
    const q = document.getElementById('search').value.trim().toLowerCase();
    const dept = document.getElementById('dept-filter').value;
    let list = allProducts;
    if (dept) list = list.filter(p => p.dept === dept);
    if (q) list = list.filter(p => p.name.toLowerCase().includes(q) || p.purchases.some(i => i.name.toLowerCase().includes(q)));
    const dir = sortDir === 'desc' ? -1 : 1;
    list = [...list].sort((a, b) => (a[sortBy] - b[sortBy]) * dir);
    document.querySelectorAll('.th-sortable').forEach(th => {
        th.querySelector('.sort-indicator').textContent = th.dataset.sort === sortBy ? (sortDir === 'desc' ? ' ↓' : ' ↑') : '';
    });
    renderList(list);
}

const TABS = ['products', 'spending', 'receipts', 'deals'];

function switchTab(tab) {
    TABS.forEach(t => {
        document.getElementById(`tab-${t}`).classList.toggle('hidden', t !== tab);
        document.getElementById(`nav-${t}`).classList.toggle('active', t === tab);
    });
    if (tab === 'spending' && !spendChart && allItems.length) initSpending();
    if (tab === 'deals') loadDeals();
}

// ── Products list ─────────────────────────────────────────────────────────────

function populateDeptFilter(products) {
    const sel = document.getElementById('dept-filter');
    const current = sel.value;
    const depts = [...new Set(products.map(p => p.dept).filter(Boolean))].sort();
    sel.innerHTML = '<option value="">All Departments</option>' + depts.map(d => `<option>${esc(d)}</option>`).join('');
    sel.value = current;
}

function renderList(products) {
    const top = products.slice(0, 150);
    document.getElementById('result-count').textContent = products.length > 150
        ? `Showing top 150 of ${products.length} products`
        : `Showing ${products.length} product${products.length !== 1 ? 's' : ''}`;
    const tbody = document.getElementById('product-body');
    if (!top.length) { tbody.innerHTML = '<tr><td colspan="6" class="loading-msg">No products match your search.</td></tr>'; return; }
    tbody.innerHTML = top.map((p, i) => {
        const lastCls = p.count > 1 && Math.abs(p.last - p.avg) / p.avg > 0.05 ? (p.last > p.avg ? 'delta-up' : 'delta-down') : '';
        return `<tr>
            <td class="rank-num col-rank">${i + 1}</td>
            <td><span class="product-link" data-name="${esc(p.name)}">${esc(p.name)}</span></td>
            <td><span class="dept-tag">${esc(p.dept)}</span></td>
            <td class="col-num count-cell">${fmtQty(p.count)}</td>
            <td class="col-num price-cell">${money(p.avg)}</td>
            <td class="col-num ${lastCls}">${money(p.last)}</td>
        </tr>`;
    }).join('');
    tbody.querySelectorAll('.product-link').forEach(el => el.addEventListener('click', () => showDetail(el.dataset.name)));
}

// ── Product detail ────────────────────────────────────────────────────────────

function showDetail(name) {
    const p = allProducts.find(x => x.name === name);
    if (!p) return;
    switchTab('products');
    document.getElementById('list-view').classList.add('hidden');
    document.getElementById('detail-view').classList.remove('hidden');
    window.scrollTo(0, 0);
    document.getElementById('detail-name').textContent = p.name;
    document.getElementById('detail-dept').textContent = p.dept;
    document.getElementById('detail-count').textContent = fmtQty(p.count);
    document.getElementById('detail-avg').textContent = money(p.avg);
    document.getElementById('detail-range').textContent = `${money(p.min)} – ${money(p.max)}`;
    document.getElementById('detail-last').textContent = money(p.last);
    document.getElementById('detail-insight').textContent = productInsight(p);
    renderChart(p);
    document.getElementById('history-body').innerHTML = [...p.purchases].reverse().map(i => `<tr>
        <td>${fmtDate(i.date)}</td>
        <td>${esc(i.store)}</td>
        <td>${esc(i.name)}</td>
        <td>${esc(i.brand) || '<span class="muted">—</span>'}</td>
        <td class="col-num">${fmtQty(i.quantity)}${i.unit !== 'each' ? ' ' + i.unit : ''}</td>
        <td class="col-num price-cell">${money(i.unit_price)}${i.unit !== 'each' ? '/' + i.unit : ''}${i.savings > 0 ? ` <span class="saved-tag">−${money(i.savings)}</span>` : ''}</td>
    </tr>`).join('');
}

// One plain-language takeaway per product: cheapest brand/store, or whether the price is drifting.
function productInsight(p) {
    if (p.purchases.length < 2) return '';
    const byBrand = {};
    for (const i of p.purchases) {
        const key = `${i.brand || 'Unbranded'} at ${i.store}`;
        (byBrand[key] ??= []).push(i.unit_price);
    }
    const options = Object.entries(byBrand)
        .map(([k, v]) => ({ k, avg: v.reduce((s, x) => s + x, 0) / v.length, n: v.length }))
        .sort((a, b) => a.avg - b.avg);
    const parts = [];
    if (options.length > 1) {
        const best = options[0], worst = options.at(-1);
        parts.push(`Cheapest option you've bought: ${best.k} (avg ${money(best.avg)}), vs ${worst.k} (avg ${money(worst.avg)}).`);
    }
    const yearAgo = new Date(); yearAgo.setFullYear(yearAgo.getFullYear() - 1);
    const older = p.purchases.filter(i => parseIso(i.date) < yearAgo);
    if (older.length) {
        const oldAvg = older.reduce((s, i) => s + i.unit_price, 0) / older.length;
        const pct = (p.last - oldAvg) / oldAvg;
        if (Math.abs(pct) >= 0.05) parts.push(`Your last price is ${Math.abs(pct * 100).toFixed(0)}% ${pct > 0 ? 'higher' : 'lower'} than a year ago.`);
    }
    return parts.join(' ');
}

function goBack() {
    document.getElementById('detail-view').classList.add('hidden');
    document.getElementById('list-view').classList.remove('hidden');
}

const PALETTE = ['#2a7a48', '#f0a500', '#3b82c4', '#c4573b', '#8a5cc4', '#4bb3a6'];

function renderChart(p) {
    if (currentChart) currentChart.destroy();
    const stores = [...new Set(p.purchases.map(i => i.store))];
    currentChart = new Chart(document.getElementById('price-chart').getContext('2d'), {
        type: 'scatter',
        data: {
            datasets: [
                ...stores.map((s, idx) => ({
                    label: s,
                    data: p.purchases.filter(i => i.store === s).map(i => ({ x: parseIso(i.date).getTime(), y: i.unit_price, item: i })),
                    backgroundColor: PALETTE[idx % PALETTE.length],
                    pointRadius: 5, pointHoverRadius: 7,
                })),
                {
                    label: 'Trend', type: 'line',
                    data: p.purchases.map(i => ({ x: parseIso(i.date).getTime(), y: i.unit_price })),
                    borderColor: 'rgba(42,122,72,0.35)', borderWidth: 1.5, pointRadius: 0, tension: 0.2,
                },
                {
                    label: 'Your Average', type: 'line',
                    data: [p.purchases[0], p.purchases.at(-1)].map(i => ({ x: parseIso(i.date).getTime(), y: p.avg })),
                    borderColor: '#f0a500', borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0,
                },
            ],
        },
        options: {
            responsive: true,
            plugins: {
                tooltip: {
                    callbacks: {
                        label: ctx => {
                            const it = ctx.raw.item;
                            return it ? ` ${money(it.unit_price)} — ${it.name} (${it.store}, ${fmtDate(it.date)})` : ` ${money(ctx.parsed.y)}`;
                        },
                    },
                },
            },
            scales: {
                x: { type: 'linear', ticks: { callback: v => new Date(v).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }), maxTicksLimit: 10 }, grid: { display: false } },
                y: { ticks: { callback: v => `$${Number(v).toFixed(2)}` }, grid: { color: '#f0f0f0' } },
            },
        },
    });
}

// ── Spending ──────────────────────────────────────────────────────────────────

let spendMonths = [];
const monthKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const monthLabel = k => new Date(`${k}-01T00:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

function initSpending() {
    const months = {};
    const month = k => (months[k] ??= { key: k, total: 0, trips: 0, byStore: {}, byDept: {} });
    for (const r of allReceipts) {
        const m = month(r.date.slice(0, 7));
        const amount = r.total ?? r.items_total;
        m.total += amount;
        m.trips += 1;
        m.byStore[r.store] = (m.byStore[r.store] || 0) + amount;
    }
    for (const i of allItems) {
        const m = month(i.date.slice(0, 7));
        m.byDept[i.department] = (m.byDept[i.department] || 0) + i.line_total;
    }
    spendMonths = Object.values(months).sort((a, b) => a.key.localeCompare(b.key));
    if (!spendMonths.length) return;

    const selA = document.getElementById('spend-month');
    const selB = document.getElementById('spend-compare');
    const opts = [...spendMonths].reverse().map(m => `<option value="${m.key}">${monthLabel(m.key)}</option>`).join('');
    selA.innerHTML = opts;
    selB.innerHTML = opts;
    selA.value = spendMonths.at(-1).key;
    selB.value = spendMonths.at(-2)?.key ?? spendMonths.at(-1).key;
    selA.onchange = renderSpending;
    selB.onchange = renderSpending;

    const stores = [...new Set(spendMonths.flatMap(m => Object.keys(m.byStore)))];
    spendChart = new Chart(document.getElementById('spend-chart').getContext('2d'), {
        type: 'bar',
        data: {
            labels: spendMonths.map(m => monthLabel(m.key)),
            datasets: stores.map((s, i) => ({ label: s, data: spendMonths.map(m => m.byStore[s] || 0), backgroundColor: PALETTE[i % PALETTE.length] })),
        },
        options: {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                tooltip: {
                    filter: ctx => ctx.parsed.y > 0,
                    callbacks: {
                        label: ctx => ` ${ctx.dataset.label}: ${money(ctx.parsed.y)}`,
                        footer: items => `Total: ${money(spendMonths[items[0].dataIndex].total)}`,
                    },
                },
            },
            scales: {
                x: { stacked: true, grid: { display: false } },
                y: { stacked: true, ticks: { callback: v => `$${v}` }, grid: { color: '#f0f0f0' } },
            },
        },
    });
    renderSpending();
    renderPriceChanges();
}

function renderSpending() {
    const a = spendMonths.find(m => m.key === document.getElementById('spend-month').value);
    const b = spendMonths.find(m => m.key === document.getElementById('spend-compare').value);
    const idx = spendMonths.indexOf(a);
    const prior = spendMonths.slice(Math.max(0, idx - 6), idx);
    const priorAvg = prior.length ? prior.reduce((s, m) => s + m.total, 0) / prior.length : 0;
    const delta = a.total - b.total;
    const partial = a.key === monthKey(new Date()) ? ' (month to date)' : '';

    document.getElementById('spend-total').textContent = money(a.total);
    document.getElementById('spend-total-lbl').textContent = `spent in ${monthLabel(a.key)}${partial}`;
    const deltaEl = document.getElementById('spend-delta');
    deltaEl.textContent = `${delta >= 0 ? '+' : '−'}${money(Math.abs(delta))}`;
    deltaEl.className = `summary-num ${delta > 0 ? 'delta-up' : 'delta-down'}`;
    document.getElementById('spend-delta-lbl').textContent = `vs ${monthLabel(b.key)}`;
    document.getElementById('spend-trips').textContent = a.trips;
    document.getElementById('spend-avg').textContent = prior.length ? money(priorAvg) : '—';

    document.getElementById('dept-th-a').textContent = monthLabel(a.key);
    document.getElementById('dept-th-b').textContent = monthLabel(b.key);
    const depts = [...new Set([...Object.keys(a.byDept), ...Object.keys(b.byDept)])]
        .map(d => ({ d, va: a.byDept[d] || 0, vb: b.byDept[d] || 0 }))
        .sort((x, y) => y.va - x.va || y.vb - x.vb);
    document.getElementById('dept-body').innerHTML = depts.map(({ d, va, vb }) => {
        const diff = va - vb;
        const cls = Math.abs(diff) < 0.005 ? '' : diff > 0 ? 'delta-up' : 'delta-down';
        return `<tr>
            <td><span class="dept-tag">${esc(d)}</span></td>
            <td class="col-num price-cell">${money(va)}</td>
            <td class="col-num">${money(vb)}</td>
            <td class="col-num ${cls}">${diff >= 0 ? '+' : '−'}${money(Math.abs(diff))}</td>
        </tr>`;
    }).join('');
}

function renderPriceChanges() {
    const cutoff = parseIso(`${spendMonths.at(-1).key}-01`);
    cutoff.setMonth(cutoff.getMonth() - 2);   // last 3 calendar months, incl. the current one
    const avg = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
    const rows = allProducts.map(p => {
        const recent = [], before = [];
        for (const i of p.purchases) (parseIso(i.date) >= cutoff ? recent : before).push(i.unit_price);
        if (recent.length < 3 || before.length < 3) return null;
        const ra = avg(recent), ba = avg(before);
        return { p, ra, ba, pct: (ra - ba) / ba };
    }).filter(Boolean).sort((x, y) => y.pct - x.pct);

    const body = document.getElementById('price-change-body');
    body.innerHTML = rows.length ? rows.map(({ p, ra, ba, pct }) => {
        const cls = Math.abs(pct) < 0.02 ? '' : pct > 0 ? 'delta-up' : 'delta-down';
        return `<tr>
            <td><span class="product-link" data-name="${esc(p.name)}">${esc(p.name)}</span></td>
            <td class="col-num">${money(ba)}</td>
            <td class="col-num price-cell">${money(ra)}</td>
            <td class="col-num ${cls}">${pct >= 0 ? '+' : '−'}${Math.abs(pct * 100).toFixed(0)}%</td>
            <td class="col-num">${money(p.min)}</td>
        </tr>`;
    }).join('') : '<tr><td colspan="5" class="loading-msg">Not enough repeat purchases yet.</td></tr>';
    body.querySelectorAll('.product-link').forEach(el => el.addEventListener('click', () => showDetail(el.dataset.name)));
}

// ── Receipts ──────────────────────────────────────────────────────────────────

function renderReceipts() {
    const body = document.getElementById('receipt-body');
    if (!allReceipts.length) { body.innerHTML = '<tr><td colspan="6" class="loading-msg">No receipts yet.</td></tr>'; return; }
    body.innerHTML = allReceipts.map(r => `<tr class="receipt-row" data-id="${r.id}">
        <td>${fmtDate(r.date)}</td>
        <td>${esc(r.store)}</td>
        <td class="col-num">${r.item_count}</td>
        <td class="col-num">${r.savings > 0 ? money(r.savings) : ''}</td>
        <td class="col-num price-cell">${money(r.total ?? r.items_total)}</td>
        <td class="col-num"><button class="nav-link-btn danger" data-delete="${r.id}">Delete</button></td>
    </tr><tr class="receipt-detail hidden" id="receipt-detail-${r.id}"><td colspan="6"></td></tr>`).join('');

    body.querySelectorAll('.receipt-row').forEach(row => row.addEventListener('click', e => {
        if (e.target.dataset.delete) return;
        toggleReceipt(Number(row.dataset.id));
    }));
    body.querySelectorAll('[data-delete]').forEach(btn => btn.addEventListener('click', () => deleteReceipt(Number(btn.dataset.delete))));
}

async function toggleReceipt(id) {
    const row = document.getElementById(`receipt-detail-${id}`);
    if (!row.classList.contains('hidden')) { row.classList.add('hidden'); return; }
    row.classList.remove('hidden');
    const cell = row.firstElementChild;
    cell.innerHTML = '<span class="muted">Loading…</span>';
    try {
        const { receipt } = await api(`/receipts/${id}`);
        cell.innerHTML = `<table class="inner-table">${receipt.items.map(i => `<tr>
            <td>${esc(i.name)}</td><td class="muted">${esc(i.item_basic)}</td>
            <td class="col-num">${fmtQty(i.quantity)}${i.unit !== 'each' ? ' ' + i.unit : ''}</td>
            <td class="col-num">${money(i.line_total)}</td></tr>`).join('')}</table>`;
    } catch (err) {
        cell.textContent = err.message;
    }
}

async function deleteReceipt(id) {
    const r = allReceipts.find(x => x.id === id);
    if (!confirm(`Delete the ${r.store} receipt from ${fmtDate(r.date)} (${money(r.total ?? r.items_total)})? This can't be undone.`)) return;
    try {
        await api(`/receipts/${id}`, { method: 'DELETE' });
        await loadData();
    } catch (err) {
        showStatus(err.message, 'error');
    }
}

function showStatus(msg, kind = 'info') {
    const el = document.getElementById('receipt-status');
    el.textContent = msg;
    el.className = `deals-status ${kind}`;
    if (!msg) el.classList.add('hidden');
}

// Photos are downscaled before upload; Claude reads receipts well at ~2000px on the long edge.
function encodeImage(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const scale = Math.min(1, 2400 / Math.max(img.width, img.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(img.src);
            resolve({ media_type: 'image/jpeg', data: canvas.toDataURL('image/jpeg', 0.88).split(',')[1] });
        };
        img.onerror = () => reject(new Error(`Could not read ${file.name}`));
        img.src = URL.createObjectURL(file);
    });
}

function encodeRaw(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ media_type: file.type, data: reader.result.split(',')[1] });
        reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
        reader.readAsDataURL(file);
    });
}

let reviewDraft = null;

async function onReceiptFiles(e) {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    showStatus('Reading your receipt… this usually takes 20–60 seconds.');
    try {
        const encoded = await Promise.all(files.map(f => (f.type === 'application/pdf' ? encodeRaw(f) : encodeImage(f))));
        const { draft } = await api('/receipts/parse', { method: 'POST', body: JSON.stringify({ files: encoded }) });
        openReview(draft);
        showStatus(draft.duplicate_of ? 'Heads up: this looks like a receipt you already saved.' : '', draft.duplicate_of ? 'error' : 'info');
    } catch (err) {
        showStatus(err.message, 'error');
    }
}

function openReview(draft) {
    reviewDraft = draft;
    document.getElementById('rv-store').value = draft.store;
    document.getElementById('rv-date').value = draft.date;
    document.getElementById('rv-tax').value = draft.tax;
    document.getElementById('rv-fees').value = draft.fees;
    document.getElementById('rv-total').value = draft.total;
    document.getElementById('rv-warnings').innerHTML = (draft.warnings || []).map(w => `<li>${esc(w)}</li>`).join('');
    const deptOptions = d => departments.map(x => `<option${x === d ? ' selected' : ''}>${esc(x)}</option>`).join('');
    document.getElementById('rv-items').innerHTML = draft.items.map((i, idx) => `<tr data-idx="${idx}">
        <td><input data-f="name" value="${esc(i.name)}" title="${esc(i.raw_name)}"></td>
        <td><input data-f="brand" value="${esc(i.brand)}"></td>
        <td><input data-f="item_basic" value="${esc(i.item_basic)}" list="item-basic-list"></td>
        <td><select data-f="department">${deptOptions(i.department)}</select></td>
        <td class="col-num"><input data-f="quantity" type="number" step="any" value="${i.quantity}" class="num-input"> ${i.unit !== 'each' ? i.unit : ''}</td>
        <td class="col-num"><input data-f="line_total" type="number" step="0.01" value="${i.line_total}" class="num-input"></td>
        <td class="col-num"><input data-f="savings" type="number" step="0.01" value="${i.savings}" class="num-input"></td>
        <td><button class="nav-link-btn danger" data-remove="${idx}" title="Remove line">✕</button></td>
    </tr>`).join('');
    document.querySelectorAll('#rv-items [data-remove]').forEach(b => b.addEventListener('click', () => {
        b.closest('tr').remove();
        updateReviewSum();
    }));
    document.querySelectorAll('#rv-items input, #rv-tax, #rv-fees, #rv-total').forEach(el => el.addEventListener('input', updateReviewSum));
    updateReviewSum();
    document.getElementById('review').classList.remove('hidden');
}

function collectReview() {
    const num = id => Number(document.getElementById(id).value) || 0;
    const items = [...document.querySelectorAll('#rv-items tr')].map(tr => {
        const base = reviewDraft.items[Number(tr.dataset.idx)];
        const val = f => tr.querySelector(`[data-f="${f}"]`).value;
        const quantity = Number(val('quantity')) || 1;
        const line_total = Number(val('line_total')) || 0;
        return {
            raw_name: base.raw_name, name: val('name').trim(), brand: val('brand').trim(), item_basic: val('item_basic').trim(),
            department: val('department'), quantity, unit: base.unit,
            unit_price: Math.round((line_total / quantity) * 100) / 100, line_total, savings: Number(val('savings')) || 0,
        };
    });
    return {
        store: document.getElementById('rv-store').value.trim(),
        date: document.getElementById('rv-date').value,
        store_address: reviewDraft.store_address,
        subtotal: reviewDraft.subtotal,
        savings: items.reduce((s, i) => s + i.savings, 0),
        tax: num('rv-tax'), fees: num('rv-fees'), total: num('rv-total'),
        items, source: 'web',
    };
}

function updateReviewSum() {
    const r = collectReview();
    const sum = r.items.reduce((s, i) => s + i.line_total, 0) + r.tax + r.fees;
    const off = Math.abs(sum - r.total) > 0.02;
    const el = document.getElementById('rv-sum');
    el.textContent = `${r.items.length} items · items + tax + fees = ${money(sum)}${off ? ` (receipt total ${money(r.total)})` : ' ✓ matches total'}`;
    el.className = off ? 'delta-up' : 'delta-down';
}

function closeReview() {
    reviewDraft = null;
    document.getElementById('review').classList.add('hidden');
    showStatus('');
}

async function saveReview() {
    const body = collectReview();
    const btn = document.getElementById('rv-save');
    btn.disabled = true;
    try {
        try {
            await api('/receipts', { method: 'POST', body: JSON.stringify(body) });
        } catch (err) {
            if (err.status !== 409 || !confirm(`${err.message} Save it anyway?`)) throw err;
            await api('/receipts', { method: 'POST', body: JSON.stringify({ ...body, allow_duplicate: true }) });
        }
        closeReview();
        showStatus(`Saved ${body.store} receipt from ${fmtDate(body.date)}.`);
        await loadData();
    } catch (err) {
        showStatus(err.message, 'error');
    } finally {
        btn.disabled = false;
    }
}

// ── Deals ─────────────────────────────────────────────────────────────────────

let dealsState = null;
let dealsLoaded = false;

function initDeals() {
    document.getElementById('dl-check').addEventListener('click', runDealsCheck);
    document.getElementById('dl-find').addEventListener('click', findStores);
    document.getElementById('dl-zip').addEventListener('keydown', e => { if (e.key === 'Enter') findStores(); });
    document.getElementById('dl-terms-save').addEventListener('click', saveTerms);
    document.getElementById('dl-terms-reset').addEventListener('click', () => {
        if (dealsState) setTermsBox(dealsState.default_terms);
    });
}

function dealsStatus(msg, kind = 'info') {
    const el = document.getElementById('dl-status');
    el.textContent = msg;
    el.className = `deals-status ${kind}`;
    if (!msg) el.classList.add('hidden');
}

async function loadDeals(force = false) {
    if (dealsLoaded && !force) return;
    try {
        dealsState = await api('/deals/status');
        dealsLoaded = true;
        renderDealsSetup();
        setTermsBox(dealsState.terms);
        renderCycle(dealsState.cycle, dealsState.last_daily);
        if (dealsState.latest) renderDealResults(dealsState.latest.run, dealsState.latest.checks);
    } catch (err) {
        dealsStatus(`Could not load deals: ${err.message}`, 'error');
    }
}

function renderDealsSetup() {
    const s = dealsState;
    const line = document.getElementById('dl-store-line');
    const zipRow = document.getElementById('dl-zip-row');
    document.getElementById('dl-locations').innerHTML = '';
    if (!s.configured) {
        line.textContent = 'Kroger API keys are not set on the server (KROGER_CLIENT_ID and KROGER_CLIENT_SECRET).';
        zipRow.classList.add('hidden');
    } else if (!s.location) {
        line.textContent = 'Pick the Ralphs you shop at. Prices are store-specific.';
        zipRow.classList.remove('hidden');
    } else {
        line.innerHTML = `Checking <strong>${esc(s.location.name)}</strong>, ${esc(s.location.address)}. <button class="nav-link-btn" id="dl-change">Change</button>`;
        zipRow.classList.add('hidden');
        document.getElementById('dl-change').addEventListener('click', () => zipRow.classList.remove('hidden'));
    }
    document.getElementById('dl-check').disabled = !(s.configured && s.location);
}

async function findStores() {
    const zip = document.getElementById('dl-zip').value.trim();
    const list = document.getElementById('dl-locations');
    list.innerHTML = '<li class="muted">Searching…</li>';
    try {
        const { locations } = await api(`/deals/locations?zip=${encodeURIComponent(zip)}`);
        if (!locations.length) { list.innerHTML = '<li class="muted">No Ralphs found near that ZIP.</li>'; return; }
        list.innerHTML = locations.map((l, i) => `<li><span><strong>${esc(l.name)}</strong><br><span class="muted">${esc(l.address)}</span></span>
            <button class="nav-link-btn" data-pick="${i}">Use this store</button></li>`).join('');
        list.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', async () => {
            try {
                const { location } = await api('/deals/location', { method: 'PUT', body: JSON.stringify(locations[Number(b.dataset.pick)]) });
                dealsState.location = location;
                renderDealsSetup();
            } catch (err) { dealsStatus(err.message, 'error'); }
        }));
    } catch (err) {
        list.innerHTML = '';
        dealsStatus(err.message, 'error');
    }
}

function setTermsBox(terms) {
    document.getElementById('dl-terms').value = terms.join('\n');
    document.getElementById('dl-term-count').textContent = terms.length;
}

async function saveTerms() {
    const terms = document.getElementById('dl-terms').value.split('\n').map(t => t.trim()).filter(Boolean);
    try {
        const res = await api('/deals/terms', { method: 'PUT', body: JSON.stringify({ terms }) });
        dealsState.terms = res.terms;
        setTermsBox(res.terms);
        dealsStatus(`Saved ${res.terms.length} search terms.`);
    } catch (err) { dealsStatus(err.message, 'error'); }
}

async function runDealsCheck() {
    const btn = document.getElementById('dl-check');
    btn.disabled = true;
    dealsStatus(`Checking ${dealsState.terms.length} items at Ralphs…`);
    try {
        const { run, checks, failed } = await api('/deals/check', { method: 'POST', body: '{}' });
        renderDealResults(run, checks);
        dealsStatus(failed.length ? `Done, but ${failed.length} search(es) failed: ${failed.join('; ')}` : '', failed.length ? 'error' : 'info');
    } catch (err) {
        dealsStatus(err.message, 'error');
    } finally {
        btn.disabled = false;
    }
}

// Size string from Kroger ("16 oz", "1.5 lb", "12 ct") → pounds or a count, for per-unit prices.
function parseSize(size) {
    const s = String(size || '').toLowerCase();
    const n = v => (v.includes('/') ? Number(v.split('/')[0]) / Number(v.split('/')[1]) : Number(v));
    let m = s.match(/([\d.]+(?:\/\d+)?)\s*(lb|lbs|pound|pounds)\b/);
    if (m) return { lb: n(m[1]) };
    m = s.match(/([\d.]+(?:\/\d+)?)\s*oz\b/);
    if (m && !/fl\.?\s*oz/.test(s)) return { lb: n(m[1]) / 16 };
    m = s.match(/(\d+)\s*(ct|count|pk|pack|rolls?|mega rolls?|double rolls?)\b/);
    if (m) return { count: Number(m[1]) };
    return {};
}

function perUnit(p, value) {
    if (value == null) return null;
    if (p.sold_by === 'WEIGHT') return { value, unit: 'lb' };
    const sz = parseSize(p.size);
    if (sz.lb) return { value: value / sz.lb, unit: 'lb' };
    if (sz.count > 1) return { value: value / sz.count, unit: 'ea' };
    return null;
}

// Rough "what you usually pay" for a search term, from receipt history: purchases whose
// item type shares the term's words, median price over the last year. Phase 2 replaces this
// with explicit links between watch items and receipt item types.
const stem = w => w.replace(/(es|s)$/, '');
function usualPrice(term) {
    const words = term.toLowerCase().split(/\s+/).map(stem).filter(w => w.length > 2);
    const yearAgo = new Date(); yearAgo.setFullYear(yearAgo.getFullYear() - 1);
    const matches = allItems.filter(i => {
        const basic = i.item_basic.toLowerCase().split(/\s+/).map(stem);
        return parseIso(i.date) >= yearAgo && (words.every(w => basic.includes(w)) || basic.every(w => words.includes(w)));
    });
    if (!matches.length) return null;
    const byUnit = {};
    for (const i of matches) (byUnit[i.unit === 'each' ? 'each' : i.unit] ??= []).push(i);
    const [unit, rows] = Object.entries(byUnit).sort((a, b) => b[1].length - a[1].length)[0];
    const prices = rows.map(i => (unit === 'oz' ? i.unit_price * 16 : unit === 'kg' ? i.unit_price / 2.2046 : i.unit_price)).sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    const median = prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
    return { value: median, unit: unit === 'each' ? 'each' : 'lb', n: rows.length, types: [...new Set(rows.map(i => i.item_basic))] };
}

function compareToUsual(p, usual) {
    if (!usual) return null;
    const now = p.promo ?? p.regular;
    if (usual.unit === 'lb') {
        const pu = perUnit(p, now);
        return pu && pu.unit === 'lb' ? (pu.value - usual.value) / usual.value : null;
    }
    if (p.sold_by === 'WEIGHT') return null;
    return (now - usual.value) / usual.value;
}

function renderDealResults(run, checks) {
    const groups = new Map();
    for (const c of checks) (groups.get(c.term) ?? groups.set(c.term, []).get(c.term)).push(c);
    let onSale = 0, below = 0;
    const html = [...groups].map(([term, products]) => {
        const usual = usualPrice(term);
        const rows = products.map(p => {
            const pct = compareToUsual(p, usual);
            const isBelow = pct !== null && pct <= -0.15;
            if (p.promo) onSale++;
            if (isBelow) below++;
            const off = p.promo ? Math.round((1 - p.promo / p.regular) * 100) : 0;
            const pu = perUnit(p, p.promo ?? p.regular);
            const tags = [
                p.promo ? `<span class="pc-tag pc-tag--save">Sale ${off}% off</span>` : '',
                isBelow ? `<span class="pc-tag pc-tag--save">${Math.round(-pct * 100)}% below usual</span>` : '',
                pct !== null && pct > 0.15 ? `<span class="pc-tag pc-tag--over">${Math.round(pct * 100)}% above usual</span>` : '',
            ].join(' ');
            return `<tr class="${p.promo ? 'dl-on-sale' : ''}">
                <td><span class="dl-product">${esc(p.description)}</span><span class="dl-size">${esc(p.size)}${p.sold_by === 'WEIGHT' ? ' · priced per lb' : ''}</span></td>
                <td class="col-num price-cell">${p.promo ? `<span class="dl-was">${money(p.regular)}</span>${money(p.promo)}` : money(p.regular)}</td>
                <td class="col-num">${pu ? `${money(pu.value)}/${pu.unit}` : '<span class="muted">—</span>'}</td>
                <td>${tags}${p.promo_expires ? ` <span class="muted">until ${fmtDate(p.promo_expires)}</span>` : ''}</td>
            </tr>`;
        }).join('');
        const usualLine = usual
            ? `You usually pay ${money(usual.value)}${usual.unit === 'lb' ? '/lb' : ' each'} <span class="muted">(median of ${usual.n} purchase${usual.n !== 1 ? 's' : ''}: ${esc(usual.types.join(', '))})</span>`
            : '<span class="muted">No matching purchases in the last year</span>';
        return `<div class="deal-card dl-group">
            <div class="deal-card-top"><h3>${esc(term)}</h3><span class="deal-source">${usualLine}</span></div>
            <div class="table-scroll"><table><tbody>${rows || '<tr><td class="muted">No products found at this store.</td></tr>'}</tbody></table></div>
        </div>`;
    }).join('');
    document.getElementById('dl-results').innerHTML = html;
    document.getElementById('dl-summary').classList.remove('hidden');
    document.getElementById('dl-stat-sale').textContent = onSale;
    document.getElementById('dl-stat-below').textContent = below;
    const at = new Date(run.finished_at || run.started_at);
    document.getElementById('dl-stat-checked').textContent = at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    document.getElementById('dl-stat-checked-lbl').textContent =
        `last checked, ${at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} (${run.kind === 'daily' ? 'daily check' : 'manual'})`;
}

const WEEKDAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function renderCycle(cycle, lastDaily) {
    const note = document.getElementById('dl-cycle-note');
    const bars = document.getElementById('dl-cycle-bars');
    const last = lastDaily ? ` Last daily check: ${fmtDate(lastDaily.run_date)}${lastDaily.error ? ` (failed: ${lastDaily.error})` : ''}.` : '';
    if (cycle.daily_runs < 8 || !cycle.by_weekday.length) {
        note.textContent = `A background check runs every morning to learn which day new sale prices appear. It needs about two weeks of data; ${cycle.daily_runs} day${cycle.daily_runs !== 1 ? 's' : ''} so far.${last}`;
        if (!cycle.by_weekday.length) { bars.innerHTML = ''; return; }
    } else {
        const top = [...cycle.by_weekday].sort((a, b) => b.changes - a.changes)[0];
        note.textContent = `Most sale prices change on ${WEEKDAYS[top.dow]}, so that's the best day for the weekly email (${cycle.daily_runs} days of data).${last}`;
    }
    const max = Math.max(...cycle.by_weekday.map(d => d.changes), 1);
    const byDow = Object.fromEntries(cycle.by_weekday.map(d => [d.dow, d.changes]));
    bars.innerHTML = [1, 2, 3, 4, 5, 6, 7].map(d => `<div class="dl-cycle-row">
        <span>${WEEKDAYS[d]}</span><div><div class="dl-cycle-bar" style="width:${((byDow[d] || 0) / max) * 100}%"></div></div>
        <span class="col-num muted">${byDow[d] || 0}</span></div>`).join('');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const money = v => `$${Number(v || 0).toFixed(2)}`;
const fmtQty = q => (Number.isInteger(q) ? String(q) : Number(q).toFixed(2));
const parseIso = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtDate = s => parseIso(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });

init();
