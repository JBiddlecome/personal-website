let allItems = [];
let allReceipts = [];
let allProducts = [];
let departments = [];
let sizeState = null;
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
        sizeState = items.sizes;
        allReceipts = receipts.receipts;
        departments = vocab.departments;
        document.getElementById('item-basic-list').innerHTML =
            vocab.item_basics.map(v => `<option value="${esc(v.item_basic)}">`).join('');
        refreshAll();
    } catch (err) {
        document.getElementById('product-body').innerHTML =
            `<tr><td colspan="7" class="loading-msg">Could not load data: ${esc(err.message)}</td></tr>`;
    }
}

// Re-reads the line items (after a size change or a size review) and redraws what uses them.
async function reloadItems() {
    const items = await api('/items');
    allItems = items.items;
    sizeState = items.sizes;
    refreshAll();
    dealsLoaded = false;   // the Deals tab's usual prices use these sizes too
    if (!document.getElementById('detail-view').classList.contains('hidden')) renderDetail();
}

function refreshAll() {
    allProducts = buildProducts(allItems);
    populateDeptFilter(allProducts);
    computeStats();
    renderSizePanel();
    applyFilters();
    renderReceipts();
    if (spendChart) { spendChart.destroy(); spendChart = null; }
    if (!document.getElementById('tab-spending').classList.contains('hidden')) initSpending();
}

// ── Standard prices ───────────────────────────────────────────────────────────
// Every line item comes with `std` from the server (units.js): its measure (g, ml or count), price
// per gram / ml / counted unit, size label, where the size came from, and a status
// (ok, review = AI guess to check, missing). Prices are shown per 100 g, per 100 ml, or per unit.

const displayPrice = (per, measure) => (per == null ? null : measure === 'count' ? per : per * 100);
const perLabel = (measure, countUnit) => (measure === 'g' ? '/100 g' : measure === 'ml' ? '/100 ml' : `/${countUnit || 'item'}`);
const fmtStd = (v, measure, countUnit) => (v == null || !measure ? '—' : `${v < 0.1 ? `$${Number(v).toFixed(3)}` : money(v)}${perLabel(measure, countUnit)}`);
const basisButtonLabel = (measure, countUnit) => (measure === 'g' ? 'Per 100 g' : measure === 'ml' ? 'Per 100 ml' : measure === 'count' ? `Per ${countUnit || 'item'}` : 'Per 100 g');

// The measure most of a product's sized purchases use; purchases in another measure aren't compared.
function dominant(values) {
    const counts = {};
    for (const v of values) if (v) counts[v] = (counts[v] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

const SOURCE_BADGE = {
    receipt: ['printed', 'src-ok'], you: ['yours', 'src-ok'], weighed: ['weighed', 'src-ok'],
    estimate: ['AI estimate', 'src-ai'], none: ['missing', 'src-warn'], pending: ['not reviewed yet', 'src-warn'],
};

function sizeBadge(std) {
    if (std.status === 'review') return '<span class="src-badge src-warn" title="Claude wasn\'t sure; please check">AI guess, check</span>';
    const [text, cls] = SOURCE_BADGE[std.source] || SOURCE_BADGE.none;
    return `<span class="src-badge ${cls}">${text}</span>`;
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
        const measure = dominant(p.purchases.filter(i => i.std.per != null).map(i => i.std.measure));
        const countUnit = measure === 'count' ? dominant(p.purchases.filter(i => i.std.measure === 'count').map(i => i.std.count_unit)) || 'item' : '';
        for (const i of p.purchases) i.stdPrice = measure && i.std.measure === measure ? displayPrice(i.std.per, measure) : null;
        const std = p.purchases.map(i => i.stdPrice).filter(v => v != null);
        const lastStd = p.purchases.filter(i => i.stdPrice != null).at(-1);
        const last = p.purchases.at(-1);
        return {
            ...p, measure, countUnit,
            avg: std.length ? std.reduce((s, v) => s + v, 0) / std.length : null,
            min: std.length ? Math.min(...std) : null, max: std.length ? Math.max(...std) : null,
            last: lastStd ? lastStd.stdPrice : null,
            pkgAvg: p.weighted / p.count, pkgMin: Math.min(...p.prices), pkgMax: Math.max(...p.prices), pkgLast: last.unit_price,
            missing: p.purchases.filter(i => i.std.status === 'missing').length,
            review: p.purchases.filter(i => i.std.status === 'review').length,
            otherMeasure: p.purchases.filter(i => i.std.per != null && i.std.measure !== measure).length,
        };
    });
}

function init() {
    document.getElementById('search').addEventListener('input', applyFilters);
    document.getElementById('dept-filter').addEventListener('change', applyFilters);
    document.getElementById('size-filter').addEventListener('change', applyFilters);
    document.getElementById('back-btn').addEventListener('click', goBack);
    document.querySelectorAll('#basis-filters [data-basis]').forEach(b => b.addEventListener('click', () => setDetailBasis(b.dataset.basis)));
    document.getElementById('size-review-btn').addEventListener('click', () => startSizeReview(false));
    document.getElementById('size-review-all-btn').addEventListener('click', () => startSizeReview(true));
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

const needsAttention = p => p.missing + p.review + p.otherMeasure > 0;

function applyFilters() {
    const q = document.getElementById('search').value.trim().toLowerCase();
    const dept = document.getElementById('dept-filter').value;
    const sizes = document.getElementById('size-filter').value;
    let list = allProducts;
    if (dept) list = list.filter(p => p.dept === dept);
    if (sizes === 'attention') list = list.filter(needsAttention);
    if (q) list = list.filter(p => p.name.toLowerCase().includes(q) || p.purchases.some(i => i.name.toLowerCase().includes(q)));
    const dir = sortDir === 'desc' ? -1 : 1;
    // Products without a standard price sort last either way.
    list = [...list].sort((a, b) => (a[sortBy] == null) - (b[sortBy] == null) || (a[sortBy] - b[sortBy]) * dir);
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

// ── Size review (Claude sizes every receipt line; see grocery/sizes.js) ─────────

let sizePoll = null;

function renderSizePanel() {
    const c = sizeState?.coverage;
    const r = sizeState?.review;
    const summary = document.getElementById('size-summary');
    const progress = document.getElementById('size-progress');
    if (!c) { summary.textContent = ''; return; }
    const packaged = c.total - c.weighed;
    const sized = c.known + c.estimated + c.review;
    const n = v => v.toLocaleString();
    const flags = [
        c.review ? `<span class="src-badge src-warn">${n(c.review)} AI guess${c.review !== 1 ? 'es' : ''} to check</span>` : '',
        c.missing ? `<span class="src-badge src-warn">${n(c.missing)} missing</span>` : '',
        c.pending ? `<span class="src-badge src-warn">${n(c.pending)} not reviewed yet</span>` : '',
    ].filter(Boolean).join(' ');
    summary.innerHTML = `${n(sized + c.weighed)} of ${n(c.total)} purchases have a standard price: ${n(c.known)} printed or yours, ${n(c.estimated + c.review)} AI estimates, ${n(c.weighed)} weighed at the register.${packaged ? '' : ''} ${flags}`;
    const running = r?.status === 'running';
    document.getElementById('size-review-btn').disabled = running || !c.pending;
    document.getElementById('size-review-all-btn').disabled = running;
    progress.classList.toggle('hidden', !running && !r?.error);
    progress.textContent = running ? `Reviewing ${n(r.done)} of ${n(r.total || 0)} distinct items… this takes a few minutes.`
        : r?.error ? `Last review: ${r.error}` : '';
    progress.className = `size-progress${!running && !r?.error ? ' hidden' : ''}${r?.error && !running ? ' error' : ''}`;
    if (running && !sizePoll) sizePoll = setInterval(pollSizeReview, 4000);
}

async function pollSizeReview() {
    try {
        const { review, coverage } = await api('/sizes/review');
        const wasRunning = sizeState?.review?.status === 'running';
        sizeState = { review, coverage };
        if (review?.status !== 'running') {
            clearInterval(sizePoll);
            sizePoll = null;
            if (wasRunning) await reloadItems();
        }
        renderSizePanel();
    } catch (err) { /* keep polling; a deploy or a blip shouldn't stop the progress display */ }
}

async function startSizeReview(all) {
    if (all && !confirm('Re-estimate every package size with AI? Sizes you entered or confirmed are kept; everything else is looked at again. This takes a few minutes.')) return;
    try {
        const { review } = await api('/sizes/review', { method: 'POST', body: JSON.stringify({ all }) });
        sizeState = { ...sizeState, review };
        renderSizePanel();
    } catch (err) {
        document.getElementById('size-progress').textContent = err.message;
        document.getElementById('size-progress').className = 'size-progress error';
    }
}

// ── Products list ─────────────────────────────────────────────────────────────

function populateDeptFilter(products) {
    const sel = document.getElementById('dept-filter');
    const current = sel.value;
    const depts = [...new Set(products.map(p => p.dept).filter(Boolean))].sort();
    sel.innerHTML = '<option value="">All Departments</option>' + depts.map(d => `<option>${esc(d)}</option>`).join('');
    sel.value = current;
}

function sizeFlags(p) {
    const flags = [
        p.missing ? `<span class="src-badge src-warn">${p.missing} missing</span>` : '',
        p.review ? `<span class="src-badge src-warn">${p.review} to check</span>` : '',
        p.otherMeasure ? `<span class="src-badge src-warn" title="Sized in a different measure than the rest, so not compared">${p.otherMeasure} other unit</span>` : '',
    ].filter(Boolean);
    return flags.length ? flags.join(' ') : '<span class="size-ok" title="Every purchase has a size">✓</span>';
}

function renderList(products) {
    const top = products.slice(0, 150);
    document.getElementById('result-count').textContent = products.length > 150
        ? `Showing top 150 of ${products.length} products`
        : `Showing ${products.length} product${products.length !== 1 ? 's' : ''}`;
    const tbody = document.getElementById('product-body');
    if (!top.length) { tbody.innerHTML = '<tr><td colspan="7" class="loading-msg">No products match your search.</td></tr>'; return; }
    tbody.innerHTML = top.map((p, i) => {
        const lastCls = p.avg && p.last != null && Math.abs(p.last - p.avg) / p.avg > 0.05 ? (p.last > p.avg ? 'delta-up' : 'delta-down') : '';
        return `<tr>
            <td class="rank-num col-rank">${i + 1}</td>
            <td><span class="product-link" data-name="${esc(p.name)}">${esc(p.name)}</span></td>
            <td><span class="dept-tag">${esc(p.dept)}</span></td>
            <td class="col-num count-cell">${fmtQty(p.count)}</td>
            <td class="col-num price-cell">${p.avg != null ? fmtStd(p.avg, p.measure, p.countUnit) : '<span class="muted">no sizes</span>'}</td>
            <td class="col-num ${lastCls}">${fmtStd(p.last, p.measure, p.countUnit)}</td>
            <td>${sizeFlags(p)}</td>
        </tr>`;
    }).join('');
    tbody.querySelectorAll('.product-link').forEach(el => el.addEventListener('click', () => showDetail(el.dataset.name)));
}

// ── Product detail ────────────────────────────────────────────────────────────

// The chart compares purchases on the product's standard measure (per 100 g, per 100 ml or per
// counted unit), or per item as charged. The choice is remembered per product.
let detailName = null;
let detailBasis = 'std';
let editingId = null;

const DETAIL_BASIS_KEY = 'grocery-detail-basis-v2';

function savedBases() {
    try { return JSON.parse(localStorage.getItem(DETAIL_BASIS_KEY)) || {}; } catch (_) { return {}; }
}

function rememberBasis(name, basis) {
    try { localStorage.setItem(DETAIL_BASIS_KEY, JSON.stringify({ ...savedBases(), [name]: basis })); } catch (_) {}
}

const unitSuffix = i => (i.unit !== 'each' ? '/' + i.unit : '');

function showDetail(name) {
    const p = allProducts.find(x => x.name === name);
    if (!p) return;
    switchTab('products');
    document.getElementById('list-view').classList.add('hidden');
    document.getElementById('detail-view').classList.remove('hidden');
    window.scrollTo(0, 0);
    detailName = name;
    detailBasis = savedBases()[name] || 'std';
    closeLineEditor();
    renderDetail();
}

function setDetailBasis(basis) {
    detailBasis = basis;
    rememberBasis(detailName, basis);
    renderDetail();
}

function renderDetail() {
    const p = allProducts.find(x => x.name === detailName);
    if (!p) { goBack(); return; }
    const std = detailBasis === 'std';
    const fmt = v => (std ? fmtStd(v, p.measure, p.countUnit) : money(v));
    const pts = p.purchases.map(i => ({ i, v: std ? i.stdPrice : i.unit_price })).filter(x => x.v != null);

    document.getElementById('basis-std-btn').textContent = basisButtonLabel(p.measure, p.countUnit);
    document.querySelectorAll('#basis-filters [data-basis]').forEach(b => b.classList.toggle('active', b.dataset.basis === detailBasis));
    document.getElementById('detail-name').textContent = p.name;
    document.getElementById('detail-dept').textContent = p.dept;
    document.getElementById('detail-count').textContent = fmtQty(p.count);
    document.getElementById('detail-avg').textContent = std ? fmt(p.avg) : money(p.pkgAvg);
    document.getElementById('detail-range').textContent = std ? (p.min != null ? `${fmt(p.min)} – ${fmt(p.max)}` : '—') : `${money(p.pkgMin)} – ${money(p.pkgMax)}`;
    document.getElementById('detail-last').textContent = std ? fmt(p.last) : money(p.pkgLast);
    document.getElementById('detail-insight').textContent = productInsight(pts, fmt);

    const left = p.purchases.length - pts.length;
    const notes = ['Click a point or a row below to see the receipt line and fix its size.'];
    if (std && left) notes.push(`${left} purchase${left !== 1 ? 's aren\'t' : ' isn\'t'} on this chart (no size, or sized in another unit).`);
    if (p.review) notes.push(`${p.review} size${p.review !== 1 ? 's are AI guesses' : ' is an AI guess'} to check.`);
    document.getElementById('chart-note').textContent = notes.join(' ');

    renderChart(pts, std ? p.avg : p.pkgAvg, fmt);
    document.getElementById('history-basis-th').textContent = std ? basisButtonLabel(p.measure, p.countUnit) : 'Per item';
    const body = document.getElementById('history-body');
    body.innerHTML = [...p.purchases].reverse().map(i => {
        const v = std ? i.stdPrice : i.unit_price;
        const why = i.std.per == null ? 'no size' : 'other unit';
        return `<tr class="history-row${i.id === editingId ? ' selected' : ''}" data-id="${i.id}" title="See this receipt line and fix its size">
            <td>${fmtDate(i.date)}</td>
            <td>${esc(i.store)}</td>
            <td>${esc(i.name)}</td>
            <td>${esc(i.brand) || '<span class="muted">—</span>'}</td>
            <td class="col-num">${fmtQty(i.quantity)}${i.unit !== 'each' ? ' ' + i.unit : ''}</td>
            <td>${i.std.label ? `${esc(i.std.label)} ` : ''}${sizeBadge(i.std)}</td>
            <td class="col-num">${money(i.unit_price)}${unitSuffix(i)}${i.savings > 0 ? ` <span class="saved-tag">−${money(i.savings)}</span>` : ''}</td>
            <td class="col-num price-cell">${v != null ? fmt(v) : `<span class="muted">${why}</span>`}</td>
        </tr>`;
    }).join('');
    body.querySelectorAll('.history-row').forEach(tr => tr.addEventListener('click', () => openLineEditor(Number(tr.dataset.id))));
    if (editingId) renderLineEditor();
}

// One plain-language takeaway per product: cheapest brand/store, or whether the price is drifting.
function productInsight(pts, fmt) {
    if (pts.length < 2) return '';
    const byBrand = {};
    for (const { i, v } of pts) {
        const key = `${i.brand || 'Unbranded'} at ${i.store}`;
        (byBrand[key] ??= []).push(v);
    }
    const options = Object.entries(byBrand)
        .map(([k, v]) => ({ k, avg: v.reduce((s, x) => s + x, 0) / v.length, n: v.length }))
        .sort((a, b) => a.avg - b.avg);
    const parts = [];
    if (options.length > 1) {
        const best = options[0], worst = options.at(-1);
        parts.push(`Cheapest option you've bought: ${best.k} (avg ${fmt(best.avg)}), vs ${worst.k} (avg ${fmt(worst.avg)}).`);
    }
    const yearAgo = new Date(); yearAgo.setFullYear(yearAgo.getFullYear() - 1);
    const older = pts.filter(x => parseIso(x.i.date) < yearAgo);
    if (older.length) {
        const oldAvg = older.reduce((s, x) => s + x.v, 0) / older.length;
        const pct = (pts.at(-1).v - oldAvg) / oldAvg;
        if (Math.abs(pct) >= 0.05) parts.push(`Your last price is ${Math.abs(pct * 100).toFixed(0)}% ${pct > 0 ? 'higher' : 'lower'} than a year ago.`);
    }
    return parts.join(' ');
}

function goBack() {
    closeLineEditor();
    document.getElementById('detail-view').classList.add('hidden');
    document.getElementById('list-view').classList.remove('hidden');
}

const PALETTE = ['#2a7a48', '#f0a500', '#3b82c4', '#c4573b', '#8a5cc4', '#4bb3a6'];

function renderChart(pts, avg, fmt) {
    if (currentChart) currentChart.destroy();
    const stores = [...new Set(pts.map(x => x.i.store))];
    const at = x => parseIso(x.i.date).getTime();
    const isEditing = ctx => ctx.raw?.item?.id === editingId;
    const flagged = ctx => ctx.raw?.item && ctx.raw.item.std.status !== 'ok';
    currentChart = new Chart(document.getElementById('price-chart').getContext('2d'), {
        type: 'scatter',
        data: {
            datasets: [
                ...stores.map((s, idx) => ({
                    label: s,
                    data: pts.filter(x => x.i.store === s).map(x => ({ x: at(x), y: x.v, item: x.i })),
                    backgroundColor: PALETTE[idx % PALETTE.length],
                    pointRadius: ctx => (isEditing(ctx) ? 8 : 5), pointHoverRadius: 8,
                    pointStyle: ctx => (flagged(ctx) ? 'triangle' : 'circle'),
                    borderColor: '#1a1a1a', borderWidth: ctx => (isEditing(ctx) ? 2 : 0),
                })),
                {
                    label: 'Trend', type: 'line',
                    data: pts.map(x => ({ x: at(x), y: x.v })),
                    borderColor: 'rgba(42,122,72,0.35)', borderWidth: 1.5, pointRadius: 0, pointHitRadius: 0, tension: 0.2,
                },
                ...(avg != null && pts.length ? [{
                    label: 'Your Average', type: 'line',
                    data: [pts[0], pts.at(-1)].map(x => ({ x: at(x), y: avg })),
                    borderColor: '#f0a500', borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, pointHitRadius: 0,
                }] : []),
            ],
        },
        options: {
            responsive: true,
            onClick: (e, els) => {
                const item = els.map(el => currentChart.data.datasets[el.datasetIndex].data[el.index].item).find(Boolean);
                // Deferred: opening the editor rebuilds this chart, which can't happen inside its own event.
                if (item) setTimeout(() => openLineEditor(item.id));
            },
            onHover: (e, els) => {
                e.native.target.style.cursor = els.some(el => currentChart.data.datasets[el.datasetIndex].data[el.index].item) ? 'pointer' : 'default';
            },
            plugins: {
                tooltip: {
                    callbacks: {
                        label: ctx => {
                            const it = ctx.raw.item;
                            if (!it) return ` ${fmt(ctx.parsed.y)}`;
                            const size = it.std.label ? `, ${it.std.label}` : '';
                            return ` ${fmt(ctx.parsed.y)} — ${it.name} (${it.store}, ${fmtDate(it.date)}${size})`;
                        },
                    },
                },
            },
            scales: {
                x: { type: 'linear', ticks: { callback: v => new Date(v).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }), maxTicksLimit: 10 }, grid: { display: false } },
                y: { ticks: { callback: v => (Math.abs(v) < 0.1 && v !== 0 ? `$${Number(v).toFixed(3)}` : `$${Number(v).toFixed(2)}`) }, grid: { color: '#f0f0f0' } },
            },
        },
    });
}

// ── Receipt line editor (package size) ────────────────────────────────────────

// Units the server accepts (units.js SIZE_UNITS), with grams/ml per unit for the live preview.
const SIZE_UNITS = [['g', 'g', 1, 'g'], ['kg', 'kg', 1000, 'g'], ['oz', 'oz (weight)', 28.3495, 'g'], ['lb', 'lb', 453.592, 'g'],
    ['ml', 'ml', 1, 'ml'], ['l', 'L', 1000, 'ml'], ['fl oz', 'fl oz (liquid)', 29.5735, 'ml'], ['gal', 'gal', 3785.41, 'ml'],
    ['qt', 'qt', 946.353, 'ml'], ['pt', 'pt', 473.176, 'ml']];

function openLineEditor(id) {
    editingId = id;
    renderDetail();
    document.getElementById('line-editor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeLineEditor() {
    editingId = null;
    const box = document.getElementById('line-editor');
    box.classList.add('hidden');
    box.innerHTML = '';
}

function renderLineEditor() {
    const p = allProducts.find(x => x.name === detailName);
    const i = p?.purchases.find(x => x.id === editingId);
    const box = document.getElementById('line-editor');
    if (!i) { closeLineEditor(); return; }
    const r = allReceipts.find(x => x.id === i.receipt_id);
    const weighed = i.std.source === 'weighed';
    const others = p.purchases.filter(x => x.id !== i.id && x.std.source !== 'weighed' && x.std.status !== 'ok');
    const canConfirm = ['estimate', 'receipt'].includes(i.std.source);
    const sizeNow = i.std.label
        ? `<strong>${esc(i.std.label)}</strong> ${sizeBadge(i.std)}${i.std.note ? `<span class="le-note-inline">${esc(i.std.note)}</span>` : ''}`
        : `${sizeBadge(i.std)}${i.std.note ? `<span class="le-note-inline">${esc(i.std.note)}</span>` : ''}`;

    box.classList.remove('hidden');
    box.innerHTML = `
        <div class="le-head">
            <h4>${esc(i.name)}</h4>
            <button class="nav-link-btn" id="le-close" title="Close">✕</button>
        </div>
        <dl class="le-facts">
            <div><dt>Bought</dt><dd>${fmtDate(i.date)} at ${esc(i.store)}</dd></div>
            <div><dt>On the receipt</dt><dd>${esc(i.raw_name) || '<span class="muted">—</span>'}</dd></div>
            <div><dt>Brand</dt><dd>${esc(i.brand) || '<span class="muted">—</span>'}</dd></div>
            <div><dt>Quantity bought</dt><dd>${fmtQty(i.quantity)} ${i.unit === 'each' ? '' : esc(i.unit)}</dd></div>
            <div><dt>Paid</dt><dd>${money(i.unit_price)}${unitSuffix(i)}${i.quantity !== 1 ? ` · line total ${money(i.line_total)}` : ''}${i.savings > 0 ? ` <span class="saved-tag">−${money(i.savings)} saved</span>` : ''}</dd></div>
            ${r ? `<div><dt>Receipt</dt><dd>${money(r.total ?? r.items_total)} total, ${r.item_count} items</dd></div>` : ''}
            <div class="le-wide"><dt>Package size</dt><dd>${sizeNow}${i.stdPrice != null ? ` → ${fmtStd(i.stdPrice, p.measure, p.countUnit)}` : ''}</dd></div>
        </dl>
        ${weighed ? '<p class="le-note">Weighed at the register, so its weight is already known.</p>' : `
        <form id="le-form" class="le-form">
            <p class="le-label">Set the size of one package <span class="muted">(a 6-pack of 12 oz cans is 6 × 12 fl oz; a fifth is 1 × 750 ml; 12 rolls of toilet paper is 12, counted as roll, with no size)</span></p>
            <div class="le-row">
                <label>Count in package <input id="le-count" class="dl-input le-num" type="number" min="1" step="any" value="${i.pack_count || 1}"></label>
                <span class="le-x">×</span>
                <label>Size of each <input id="le-amount" class="dl-input le-num" type="number" min="0" step="any" value="${i.size_amount ?? ''}" placeholder="e.g. 1.75"></label>
                <label>Unit <select id="le-unit" class="dl-input">${SIZE_UNITS.map(([v, label]) => `<option value="${v}"${v === (i.size_unit || 'oz') ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
                <label>Counted as <input id="le-count-unit" class="dl-input le-word" value="${esc(i.count_unit || '')}" placeholder="roll, egg, can" maxlength="30"></label>
            </div>
            <p class="le-preview" id="le-preview"></p>
            <div class="le-actions">
                <button type="submit" class="refresh-btn">Save size</button>
                ${others.length ? `<button type="button" class="nav-link-btn" id="le-save-all">Save for this and ${others.length} other purchase${others.length !== 1 ? 's' : ''} missing a size or needing a check</button>` : ''}
                ${canConfirm ? '<button type="button" class="nav-link-btn" id="le-confirm">Size looks right</button>' : ''}
                ${i.std.source === 'you' || i.std.source === 'estimate' ? '<button type="button" class="nav-link-btn danger" id="le-clear" title="Removes the size; the next AI review estimates it again">Clear size</button>' : ''}
            </div>
            <p class="deals-status hidden" id="le-status"></p>
        </form>`}`;

    document.getElementById('le-close').addEventListener('click', () => { closeLineEditor(); renderDetail(); });
    if (weighed) return;
    const read = () => {
        const count = Number(document.getElementById('le-count').value) > 0 ? Number(document.getElementById('le-count').value) : 1;
        const amount = Number(document.getElementById('le-amount').value) > 0 ? Number(document.getElementById('le-amount').value) : null;
        return { count, amount, unit: document.getElementById('le-unit').value, countUnit: document.getElementById('le-count-unit').value.trim() };
    };
    const preview = () => {
        const { count, amount, unit, countUnit } = read();
        const def = SIZE_UNITS.find(u => u[0] === unit);
        let text;
        if (amount) {
            const total = amount * def[2] * count;
            text = `${count > 1 ? `${count} × ` : ''}${amount} ${def[1].split(' ')[0]} = ${+total.toFixed(1)} ${def[3]} → ${fmtStd(displayPrice(i.unit_price / total, def[3]), def[3])}`;
        } else {
            text = `${count} ${countUnit || 'item'}${count !== 1 ? 's' : ''} → ${fmtStd(i.unit_price / count, 'count', countUnit || 'item')}. Leave "Size of each" empty only for things sold by count.`;
        }
        document.getElementById('le-preview').textContent = text;
    };
    ['le-count', 'le-amount', 'le-unit', 'le-count-unit'].forEach(id => document.getElementById(id).addEventListener('input', preview));
    preview();
    const saveFor = ids => {
        const { count, amount, unit, countUnit } = read();
        saveLineSize({ item_ids: ids, action: 'set', pack_count: count, amount, unit: amount ? unit : null, count_unit: countUnit });
    };
    document.getElementById('le-form').addEventListener('submit', e => { e.preventDefault(); saveFor([i.id]); });
    document.getElementById('le-save-all')?.addEventListener('click', () => saveFor([i.id, ...others.map(x => x.id)]));
    document.getElementById('le-confirm')?.addEventListener('click', () => saveLineSize({ item_ids: [i.id], action: 'confirm' }));
    document.getElementById('le-clear')?.addEventListener('click', () => saveLineSize({ item_ids: [i.id], action: 'clear' }));
}

async function saveLineSize(body) {
    const status = document.getElementById('le-status');
    try {
        const { updated } = await api('/items/size', { method: 'PUT', body: JSON.stringify(body) });
        await reloadItems();
        const s = document.getElementById('le-status');
        if (s) {
            s.textContent = body.action === 'confirm' ? 'Marked as checked.' : body.action === 'clear' ? 'Cleared. The next AI review will estimate it again.'
                : `Saved${updated > 1 ? ` for ${updated} purchases` : ''}.`;
            s.className = 'deals-status info';
        }
    } catch (err) {
        status.textContent = err.message;
        status.className = 'deals-status error';
    }
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
    const rows = allProducts.filter(p => p.measure).map(p => {
        const recent = [], before = [];
        for (const i of p.purchases) if (i.stdPrice != null) (parseIso(i.date) >= cutoff ? recent : before).push(i.stdPrice);
        if (recent.length < 3 || before.length < 3) return null;
        const ra = avg(recent), ba = avg(before);
        return { p, ra, ba, pct: (ra - ba) / ba };
    }).filter(Boolean).sort((x, y) => y.pct - x.pct);

    const body = document.getElementById('price-change-body');
    body.innerHTML = rows.length ? rows.map(({ p, ra, ba, pct }) => {
        const cls = Math.abs(pct) < 0.02 ? '' : pct > 0 ? 'delta-up' : 'delta-down';
        const f = v => fmtStd(v, p.measure, p.countUnit);
        return `<tr>
            <td><span class="product-link" data-name="${esc(p.name)}">${esc(p.name)}</span></td>
            <td class="col-num">${f(ba)}</td>
            <td class="col-num price-cell">${f(ra)}</td>
            <td class="col-num ${cls}">${pct >= 0 ? '+' : '−'}${Math.abs(pct * 100).toFixed(0)}%</td>
            <td class="col-num">${f(p.min)}</td>
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
let watchFilter = 'watching';

function initDeals() {
    document.getElementById('dl-check').addEventListener('click', () => runDealsCheck());
    document.getElementById('dl-find').addEventListener('click', findStores);
    document.getElementById('dl-zip').addEventListener('keydown', e => { if (e.key === 'Enter') findStores(); });
    document.getElementById('dl-seed-btn').addEventListener('click', seedWatchlist);
    document.getElementById('dl-add').addEventListener('submit', addWatchItem);
    document.getElementById('dl-watch-search').addEventListener('input', renderWatchlist);
    document.getElementById('dl-threshold').addEventListener('change', saveThreshold);
    document.getElementById('dl-email-form').addEventListener('submit', saveEmailSettings);
    document.getElementById('dl-email-test').addEventListener('click', sendTestEmail);
    const mark = document.getElementById('dl-bookmarklet');
    mark.href = couponBookmarklet();
    mark.addEventListener('click', e => { e.preventDefault(); dealsStatus('Drag the button onto your bookmarks bar, then press it on the Ralphs coupon page.'); });
    document.querySelectorAll('#dl-filters [data-filter]').forEach(b => b.addEventListener('click', () => {
        watchFilter = b.dataset.filter;
        document.querySelectorAll('#dl-filters [data-filter]').forEach(x => x.classList.toggle('active', x === b));
        renderWatchlist();
    }));
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
        renderDeals();
    } catch (err) {
        dealsStatus(`Could not load deals: ${err.message}`, 'error');
    }
}

function renderDeals() {
    renderDealsSetup();
    renderDealCards();
    renderWatchlist();
    renderAllResults();
    renderCycle(dealsState.cycle, dealsState.last_daily);
    renderEmailSettings();
    renderCoupons();
    document.getElementById('dl-threshold').value = Math.round(dealsState.threshold * 100);
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
        line.innerHTML = `<span>Checking <strong>${esc(s.location.name)}</strong>, ${esc(s.location.address)}</span> <button class="nav-link-btn" id="dl-change">Change store</button>`;
        zipRow.classList.add('hidden');
        document.getElementById('dl-change').addEventListener('click', () => zipRow.classList.remove('hidden'));
    }
    const watching = s.watch.filter(w => w.status === 'watching').length;
    document.getElementById('dl-check').disabled = !(s.configured && s.location && watching);
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

async function runDealsCheck(watchIds = null) {
    const btn = document.getElementById('dl-check');
    btn.disabled = true;
    const n = watchIds ? watchIds.length : dealsState.watch.filter(w => w.status === 'watching').length;
    dealsStatus(`Checking ${n} item${n !== 1 ? 's' : ''} at Ralphs… new products are matched by Claude, so the first check takes a minute or two.`);
    try {
        const result = await api('/deals/check', { method: 'POST', body: JSON.stringify(watchIds ? { watch_ids: watchIds } : {}) });
        const { failed, match_error } = result;
        Object.assign(dealsState, { watch: result.watch, latest: result.latest, deals: result.deals, threshold: result.threshold });
        renderDeals();
        const problems = [...(match_error ? [match_error] : []), ...(failed.length ? [`${failed.length} search(es) failed: ${failed.join('; ')}`] : [])];
        dealsStatus(problems.join(' '), problems.length ? 'error' : 'info');
    } catch (err) {
        dealsStatus(err.message, 'error');
    } finally {
        renderDealsSetup();
    }
}

// A watch item's price in its standard unit (per 100 g / 100 ml / counted unit).
const fmtW = (v, b) => fmtStd(v, b?.measure, b?.count_unit);

function renderDealCards() {
    const s = dealsState;
    const box = document.getElementById('dl-deals');
    const summary = document.getElementById('dl-summary');
    document.getElementById('dl-stat-watching').textContent = s.watch.filter(w => w.status === 'watching').length;
    if (!s.latest) {
        summary.classList.toggle('hidden', !s.watch.length);
        document.getElementById('dl-stat-deals').textContent = '—';
        document.getElementById('dl-stat-checked').textContent = '—';
        box.innerHTML = '<p class="dl-empty">No price check yet. Press <strong>Check prices now</strong>.</p>';
        return;
    }
    summary.classList.remove('hidden');
    const run = s.latest.run;
    const at = new Date(run.finished_at || run.started_at);
    document.getElementById('dl-stat-deals').textContent = s.deals.length;
    document.getElementById('dl-stat-deals-lbl').textContent = `deal${s.deals.length !== 1 ? 's' : ''} this check`;
    document.getElementById('dl-stat-checked').textContent = at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    document.getElementById('dl-stat-checked-lbl').textContent =
        `last checked, ${at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} (${run.kind === 'daily' ? 'daily check' : 'manual'})`;

    if (!s.deals.length) {
        box.innerHTML = `<p class="dl-empty">Nothing on your watchlist is ${Math.round(s.threshold * 100)}% or more below your usual price right now.</p>`;
        return;
    }
    box.innerHTML = s.deals.map(d => {
        const p = d.product;
        const b = d.baseline;
        const pct = Math.round(p.deal.pct * 100);
        const vs = p.deal.kind === 'sale_no_history'
            ? `${pct}% off Ralphs' regular ${money(p.regular)} <span class="muted">(no sized purchase history to compare)</span>`
            : p.deal.kind === 'below_target'
                ? `${pct}% below your alert price of ${fmtW(b.target, b)}`
                : `${pct}% below your usual ${fmtW(b.usual, b)} <span class="muted">(lowest you've paid ${fmtW(b.lowest, b)})</span>`;
        const why = p.deal.sale ? '' : '<span class="pc-tag">Regular price: bigger or cheaper size</span>';
        return `<div class="deal-card deal-card--highlight">
            <div class="deal-card-top">
                <span class="product-link dl-deal-name">${esc(d.name)}<span class="below-badge">${pct}% OFF</span>${why}</span>
                <span class="deal-source">${esc(d.advice)}${p.coupon ? (p.coupon.expires ? ` · coupon until ${fmtDate(p.coupon.expires)}` : '') : p.promo_expires ? ` · sale ends ${fmtDate(p.promo_expires)}` : ''}</span>
            </div>
            <p class="deal-text">${esc(p.description)} <span class="dl-size">${esc(p.size)}</span>${p.coupon ? `<span class="dl-coupon-tag">Digital coupon: ${esc(p.coupon.offer)}${p.coupon.min_qty > 1 ? ` (price is per item when you buy ${p.coupon.min_qty})` : ''}</span>` : ''}</p>
            <div class="deal-pricing">
                <span class="deal-price below-avg">${p.coupon || p.promo ? `<span class="dl-was">${money(p.regular)}</span>` : ''}${money(p.coupon?.final ?? p.promo ?? p.regular)}</span>
                ${p.unit_price != null ? `<span class="deal-vs">${fmtW(p.unit_price, b)}</span>` : ''}
                <span class="deal-vs">${vs}</span>
            </div>
        </div>`;
    }).join('');
}

function renderWatchlist() {
    const s = dealsState;
    const q = document.getElementById('dl-watch-search').value.trim().toLowerCase();
    document.getElementById('dl-seed').classList.toggle('hidden', s.watch.length > 0);
    const list = s.watch.filter(w => (watchFilter === 'all' || w.status === watchFilter)
        && (!q || w.name.toLowerCase().includes(q) || w.search_term.includes(q)));
    const counts = ['watching', 'paused', 'never'].map(st => s.watch.filter(w => w.status === st).length);
    document.getElementById('dl-watch-count').textContent =
        `${counts[0]} watching · ${counts[1]} paused · ${counts[2]} not interested`;
    const body = document.getElementById('dl-watch-body');
    if (!list.length) {
        body.innerHTML = `<tr><td colspan="6" class="loading-msg">${s.watch.length ? 'No items match.' : 'Nothing here yet.'}</td></tr>`;
        return;
    }
    const opt = (v, cur, label) => `<option value="${v}"${v === cur ? ' selected' : ''}>${label}</option>`;
    const deptOptions = d => departments.map(x => opt(x, d, esc(x))).join('');
    body.innerHTML = list.map(w => {
        const b = w.baseline;
        const flags = [b.missing ? `${b.missing} missing a size` : '', b.review ? `${b.review} to check` : ''].filter(Boolean).join(', ');
        const usual = b.usual != null
            ? `${fmtW(b.usual, b)}<span class="dl-size">${b.purchases} purchase${b.purchases !== 1 ? 's' : ''}${flags ? ` · <span class="size-missing">${flags}</span>` : ''}</span>`
            : `<span class="muted">${b.lines.length ? 'sizes missing' : 'no history'}</span>`;
        return `<tr data-id="${w.id}" class="dl-watch-row dl-status-${w.status}">
            <td><input class="dl-cell" data-f="name" value="${esc(w.name)}" aria-label="Item name"></td>
            <td><select class="dl-cell" data-f="status" aria-label="Status">${opt('watching', w.status, 'Watching')}${opt('paused', w.status, 'Paused')}${opt('never', w.status, 'Not interested')}</select></td>
            <td><input class="dl-cell" data-f="search_term" value="${esc(w.search_term)}" aria-label="Search term"></td>
            <td class="col-num">${usual}</td>
            <td class="col-num"><input class="dl-cell dl-num" data-f="target_price" type="number" min="0.001" step="any" value="${w.target_price ?? ''}" placeholder="auto" title="Optional: alert when the price is below this (${b.measure ? perLabel(b.measure, b.count_unit).slice(1) : 'per 100 g / 100 ml / unit'}), instead of using your usual price"><span class="dl-size">${b.measure ? perLabel(b.measure, b.count_unit) : ''}</span></td>
            <td class="dl-row-actions"><button class="nav-link-btn" data-more="${w.id}" title="More settings">⋯</button></td>
        </tr>
        <tr class="dl-more hidden" id="dl-more-${w.id}"><td colspan="6">
            <label>Receipt item types used for "usual price" (comma-separated)
                <input class="dl-cell" data-f="item_basics" data-id="${w.id}" value="${esc(w.item_basics.join(', '))}" list="item-basic-list"></label>
            <label>Department <select class="dl-cell" data-f="department" data-id="${w.id}">${deptOptions(w.department)}</select></label>
            <label>Notes for matching (e.g. "Angel Soft only", "boneless") <input class="dl-cell" data-f="notes" data-id="${w.id}" value="${esc(w.notes)}" maxlength="300"></label>
            ${purchaseLines(w)}
            <div class="dl-more-actions">
                <button class="nav-link-btn" data-check-one="${w.id}"${w.status !== 'watching' || !s.location ? ' disabled' : ''}>Check just this item</button>
                <button class="nav-link-btn danger" data-delete-watch="${w.id}">Remove from watchlist</button>
            </div>
        </td></tr>`;
    }).join('');

    body.querySelectorAll('.dl-cell').forEach(el => el.addEventListener('change', () => {
        const id = Number(el.dataset.id || el.closest('tr').dataset.id);
        const f = el.dataset.f;
        let v = el.value.trim();
        if (f === 'item_basics') v = v.split(',').map(x => x.trim()).filter(Boolean);
        else if (f === 'target_price') v = v === '' ? null : Number(v);
        else if (f === 'search_term') v = v.toLowerCase();
        saveWatch(id, { [f]: v });
    }));
    body.querySelectorAll('.dl-line-row').forEach(tr => tr.addEventListener('click', () => {
        showDetail(tr.dataset.basic);
        openLineEditor(Number(tr.dataset.item));
    }));
    body.querySelectorAll('[data-more]').forEach(b => b.addEventListener('click', () =>
        document.getElementById(`dl-more-${b.dataset.more}`).classList.toggle('hidden')));
    body.querySelectorAll('[data-check-one]').forEach(b => b.addEventListener('click', () => runDealsCheck([Number(b.dataset.checkOne)])));
    body.querySelectorAll('[data-delete-watch]').forEach(b => b.addEventListener('click', () => deleteWatch(Number(b.dataset.deleteWatch))));
}

// The receipt lines behind "you usually pay", with each one's size and standard price. Clicking a
// line opens it on the Products page, where its size can be fixed.
function purchaseLines(w) {
    const b = w.baseline;
    if (!b.lines.length) return '<p class="dl-lines-empty muted">No purchases of the linked receipt items in the last 12 months.</p>';
    const rows = b.lines.map(l => {
        const paid = l.unit === 'each' ? money(l.unit_price) : `${money(l.unit_price)}/${l.unit}`;
        const badge = sizeBadge({ status: l.size_status, source: l.size_source });
        return `<tr class="dl-line-row${l.price == null ? ' dl-rejected' : ''}" data-item="${l.id}" data-basic="${esc(l.item_basic)}" title="Open this purchase to fix its size">
            <td>${fmtDate(l.date)}<span class="dl-size">${esc(l.store)}</span></td>
            <td>${esc(l.name)}</td>
            <td class="col-num">${paid}</td>
            <td>${esc(l.size_label)} ${badge}</td>
            <td class="col-num">${l.price != null ? fmtW(l.price, b) : `<span class="muted">not counted: ${esc(l.why)}</span>`}</td>
        </tr>`;
    }).join('');
    return `<div class="dl-lines">
        <p class="dl-lines-head">Purchases behind your usual price (${b.measure ? `per ${perLabel(b.measure, b.count_unit).slice(1)}` : 'no sizes yet'}, last 12 months)</p>
        <div class="table-scroll"><table><tbody>${rows}</tbody></table></div>
    </div>`;
}

const WEEKDAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function renderEmailSettings() {
    const e = dealsState.email;
    document.getElementById('dl-email-on').checked = e.enabled;
    document.getElementById('dl-email-to').value = e.to;
    document.getElementById('dl-email-day').value = String(e.weekday);
    const day = WEEKDAY_NAMES[e.send_day];
    const when = e.weekday === 'auto'
        ? (e.detected_day ? `Sends ${day} mornings, the day Ralphs changes most sale prices.` : `Sends ${day} mornings (when Ralphs' weekly ad starts) until the daily checks have found the real sale-price day.`)
        : `Sends ${day} mornings.`;
    const last = e.last ? ` Last sent ${fmtDate(e.last.date)}${e.last.error ? `, but it failed: ${e.last.error}` : ''}.` : '';
    document.getElementById('dl-email-note').textContent = e.configured
        ? `${e.enabled ? when : 'Off.'} It lists the deals from that morning's check.${last}`
        : 'Email is not set up on the server (RESEND_API_KEY is missing).';
}

async function saveEmailSettings(e) {
    e.preventDefault();
    const day = document.getElementById('dl-email-day').value;
    const body = {
        enabled: document.getElementById('dl-email-on').checked,
        to: document.getElementById('dl-email-to').value.trim(),
        weekday: day === 'auto' ? 'auto' : Number(day),
    };
    try {
        const { email } = await api('/deals/email', { method: 'PUT', body: JSON.stringify(body) });
        dealsState.email = email;
        renderEmailSettings();
        dealsStatus('Email settings saved.');
    } catch (err) { dealsStatus(err.message, 'error'); }
}

async function sendTestEmail() {
    dealsStatus('Sending…');
    try {
        const { to, subject } = await api('/deals/email/test', { method: 'POST', body: '{}' });
        dealsStatus(`Sent "${subject}" to ${to}.`);
    } catch (err) { dealsStatus(err.message, 'error'); }
}

// A bookmarklet for the Ralphs coupon page: it opens /grocery/coupons.html and posts it the
// page's text (repeating until that tab says it has it). It reads nothing but the visible text.
function couponBookmarklet() {
    const origin = location.origin;
    const code = `(()=>{if(!/(^|\\.)ralphs\\.com$/.test(location.hostname)){alert('Open the Ralphs digital coupons page first.');return}`
        + `const t=document.body.innerText;const w=window.open('${origin}/grocery/coupons.html','grocery-coupons');`
        + `if(!w){alert('Allow pop-ups for ralphs.com, then press the bookmark again.');return}`
        + `let n=0;const iv=setInterval(()=>{w.postMessage({type:'ralphs-coupons',text:t},'${origin}');if(++n>120)clearInterval(iv)},500);`
        + `addEventListener('message',e=>{if(e.origin==='${origin}'&&e.data==='ralphs-coupons-received')clearInterval(iv)})})()`;
    return `javascript:${encodeURIComponent(code)}`;
}

function renderCoupons() {
    const c = dealsState.coupons;
    const note = document.getElementById('dl-coupon-note');
    const last = c.last_import;
    note.textContent = last
        ? `${c.active} coupons active, last imported ${new Date(last.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}; ${c.linked.length} may apply to watched items. Deals and the weekly email include them.${last.error ? ` Last import note: ${last.error}` : ''}`
        : 'Ralphs only shows digital coupons to signed-in shoppers, so they come from a bookmark button you press on the coupon page. Until then, prices are shelf and sale prices only.';
    document.querySelector('.dl-coupon-how').open = !last;
    const byId = new Map(dealsState.watch.map(w => [w.id, w.name]));
    document.getElementById('dl-coupon-list').innerHTML = c.linked.length ? `<details class="dl-coupon-linked">
        <summary>Coupons that may apply to your watchlist (${c.linked.length})</summary>
        <ul>${c.linked.map(x => `<li><strong>${esc(x.offer)}</strong>${x.expires ? ` <span class="muted">until ${fmtDate(x.expires)}</span>` : ''}${x.in_store ? '' : ' <span class="muted">(pickup/delivery only, not counted)</span>'}
            <span class="dl-size">${x.watch_ids.map(id => esc(byId.get(id) || '')).filter(Boolean).join(', ')}</span></li>`).join('')}</ul>
    </details>` : '';
}

// Saves one field, then reloads so baselines and deals reflect the change.
async function saveWatch(id, patch) {
    const open = [...document.querySelectorAll('.dl-more:not(.hidden)')].map(r => r.id);
    try {
        await api(`/deals/watch/${id}`, { method: 'PUT', body: JSON.stringify(patch) });
        await loadDeals(true);
        dealsStatus('');
    } catch (err) {
        dealsStatus(err.message, 'error');
        await loadDeals(true);
    }
    open.forEach(rid => document.getElementById(rid)?.classList.remove('hidden'));
}

async function deleteWatch(id) {
    const w = dealsState.watch.find(x => x.id === id);
    if (!confirm(`Remove "${w.name}" from the watchlist? To stop alerts but keep its settings, set it to Paused or Not interested instead.`)) return;
    try {
        await api(`/deals/watch/${id}`, { method: 'DELETE' });
        await loadDeals(true);
    } catch (err) { dealsStatus(err.message, 'error'); }
}

async function addWatchItem(e) {
    e.preventDefault();
    const name = document.getElementById('dl-add-name').value.trim();
    if (!name) return;
    // Link it to a receipt item type of the same name, if there is one, so it gets a usual price.
    const basic = allProducts.find(p => p.name.toLowerCase() === name.toLowerCase());
    const body = {
        name, search_term: name.toLowerCase(),
        item_basics: basic ? [basic.name] : [], department: basic?.dept || 'Other',
    };
    try {
        await api('/deals/watch', { method: 'POST', body: JSON.stringify(body) });
        document.getElementById('dl-add-name').value = '';
        watchFilter = 'watching';
        document.querySelectorAll('#dl-filters [data-filter]').forEach(x => x.classList.toggle('active', x.dataset.filter === 'watching'));
        await loadDeals(true);
        dealsStatus(`Added ${name}.${basic ? '' : ' Open ⋯ to link it to receipt items so it gets a usual price.'}`);
    } catch (err) { dealsStatus(err.message, 'error'); }
}

async function seedWatchlist() {
    try {
        const { created } = await api('/deals/watch/seed', { method: 'POST', body: '{}' });
        await loadDeals(true);
        dealsStatus(`Added ${created.length} items. Pause anything you don't want alerts for, then press Check prices now.`);
    } catch (err) { dealsStatus(err.message, 'error'); }
}

async function saveThreshold() {
    const pct = Number(document.getElementById('dl-threshold').value);
    try {
        await api('/deals/settings', { method: 'PUT', body: JSON.stringify({ threshold: pct / 100 }) });
        await loadDeals(true);
    } catch (err) { dealsStatus(err.message, 'error'); }
}

function renderAllResults() {
    const s = dealsState;
    const box = document.getElementById('dl-results');
    if (!s.latest || !s.latest.checks.length) { box.innerHTML = '<p class="muted">No results yet.</p>'; return; }
    const byWatch = new Map(s.watch.map(w => [w.id, w]));
    const groups = new Map();
    for (const c of s.latest.checks) (groups.get(c.watch_id) ?? groups.set(c.watch_id, []).get(c.watch_id)).push(c);
    box.innerHTML = [...groups].map(([wid, products]) => {
        const w = byWatch.get(wid);
        if (!w) return '';
        const rows = products.map(p => {
            const tag = p.verdict === 'match' ? `<span class="pc-tag pc-tag--save">${p.verdict_source === 'user' ? 'You: match' : 'Match'}</span>`
                : p.verdict === 'reject' ? `<span class="pc-tag">${p.verdict_source === 'user' ? 'You: not this' : 'Not this'}</span>`
                : '<span class="pc-tag pc-tag--warn">Unreviewed</span>';
            return `<tr class="${p.verdict === 'reject' ? 'dl-rejected' : ''}">
                <td><span class="dl-product">${esc(p.description)}</span><span class="dl-size">${esc(p.size)}${p.sold_by === 'WEIGHT' ? ' · priced per lb' : ''}${p.verdict_reason ? ` · ${esc(p.verdict_reason)}` : ''}</span></td>
                <td class="col-num price-cell">${p.promo ? `<span class="dl-was">${money(p.regular)}</span>${money(p.promo)}` : money(p.regular)}${p.coupon ? `<span class="dl-size" title="${esc(p.coupon.offer)}">${money(p.coupon.final)} with coupon</span>` : ''}</td>
                <td class="col-num">${p.unit_price != null ? fmtW(p.unit_price, w.baseline) : p.size_unreadable ? '<span class="muted">size unreadable</span>' : ''}</td>
                <td>${tag}${p.deal ? ` <span class="pc-tag pc-tag--save">Deal ${Math.round(p.deal.pct * 100)}%</span>` : ''}</td>
                <td class="dl-row-actions">
                    <button class="nav-link-btn" data-verdict="match" data-w="${wid}" data-p="${esc(p.product_id)}" title="This is ${esc(w.name)}">✓</button>
                    <button class="nav-link-btn" data-verdict="reject" data-w="${wid}" data-p="${esc(p.product_id)}" title="Not ${esc(w.name)}">✕</button>
                </td>
            </tr>`;
        }).join('');
        return `<div class="deal-card dl-group">
            <div class="deal-card-top"><h3>${esc(w.name)}</h3><span class="deal-source">usual ${fmtW(w.baseline.compare_to, w.baseline)}</span></div>
            <div class="table-scroll"><table><tbody>${rows}</tbody></table></div>
        </div>`;
    }).join('');
    box.querySelectorAll('[data-verdict]').forEach(b => b.addEventListener('click', async () => {
        try {
            await api('/deals/verdict', { method: 'PUT', body: JSON.stringify({ watch_id: Number(b.dataset.w), product_id: b.dataset.p, verdict: b.dataset.verdict }) });
            await loadDeals(true);
            document.querySelector('.dl-all').open = true;
        } catch (err) { dealsStatus(err.message, 'error'); }
    }));
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
