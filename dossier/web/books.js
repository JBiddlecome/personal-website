// The Library: a 3D bookshelf over books.json in the private dossier store. Edits save back to it.
(async function () {
    const $ = (id) => document.getElementById(id);
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const FILE = '/dossier/api/files/books.json';
    const cover = (b, size = 'M') => b.cover_id ? `https://covers.openlibrary.org/b/id/${b.cover_id}-${size}.jpg` : '';
    const today = () => { const n = new Date(); return new Date(n - n.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
    const SHELVES = [
        ['reading', 'Reading now'],
        ['to-read', 'To read'],
        ['read', 'Read'],
        ['dnf', 'Did not finish']
    ];

    $('logout').addEventListener('click', async () => {
        await fetch('/dossier/api/logout', { method: 'POST' }).catch(() => {});
        location.href = '/dossier';
    });

    // ── Data ────────────────────────────────────────────────────────────────
    let lib;
    try {
        const res = await fetch(FILE, { cache: 'no-store' });
        if (res.status === 401) { location.href = '/dossier/books'; return; }
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
        lib = await res.json();
    } catch (err) {
        $('room').innerHTML = `<p class="lib-loading">The library could not be opened: ${esc(err.message)}</p>`;
        return;
    }
    const books = lib.books;
    const byId = (id) => books.find((b) => b.id === id);

    let saveTimer = null;
    function queueSave() {
        state('Unsaved…');
        clearTimeout(saveTimer);
        saveTimer = setTimeout(save, 800);
    }
    async function save() {
        clearTimeout(saveTimer);
        lib.updated_at = new Date().toISOString();
        try {
            const res = await fetch(FILE, { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(lib, null, 1) });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
            state('Saved');
        } catch (err) {
            state(`Not saved: ${err.message}`);
        }
    }
    const state = (t) => { $('d-state').textContent = t; };

    // ── Book geometry & color ───────────────────────────────────────────────
    const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
    const PALETTE = ['#6b2e2a', '#2f4a3a', '#2b3d5a', '#7a5a25', '#4b2f4f', '#335c63', '#8a4a2c', '#3e3e3e', '#5c6b2e', '#7d2f45'];
    const colorOf = (b) => b.color || PALETTE[hash(b.id) % PALETTE.length];
    function inkFor(hex) {
        const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, bl = n & 255;
        return (0.299 * r + 0.587 * g + 0.114 * bl) > 150 ? '#1b1712' : '#f4ead2';
    }
    const scale = () => (window.innerWidth < 640 ? 0.72 : 1);
    const width = (b) => Math.round(Math.max(22, Math.min(60, (b.pages || 320) / 13)) * scale());
    const height = (b) => Math.round((182 + (hash(b.title) % 44)) * scale());
    const lastName = (a) => (a || '').trim().split(/\s+/).pop().toLowerCase();
    const seriesNo = (b) => parseFloat(b.series_no) || 0;

    // ── Rendering ───────────────────────────────────────────────────────────
    function sorted(list) {
        const mode = $('sort').value;
        const cmp = {
            shelf: (a, b) => lastName(a.author).localeCompare(lastName(b.author)) || (a.series || '~').localeCompare(b.series || '~') || seriesNo(a) - seriesNo(b) || a.title.localeCompare(b.title),
            added: (a, b) => (b.date_read || b.date_added || '').localeCompare(a.date_read || a.date_added || '') || a.title.localeCompare(b.title),
            rating: (a, b) => (b.rating || 0) - (a.rating || 0) || a.title.localeCompare(b.title),
            title: (a, b) => a.title.replace(/^(the|a|an) /i, '').localeCompare(b.title.replace(/^(the|a|an) /i, ''))
        }[mode];
        return [...list].sort(cmp);
    }

    function bookEl(b) {
        const c = colorOf(b), w = width(b), h = height(b);
        const stars = b.rating ? `<span class="s-stars">${'★'.repeat(b.rating)}</span>` : '';
        const no = b.series && /^\d/.test(b.series_no || '') ? `<span class="s-no">${esc(b.series_no)}</span>` : '';
        return `<button type="button" class="book" data-id="${esc(b.id)}" style="--w:${w}px;--h:${h}px;--c:${c};--ink:${inkFor(c)}" title="${esc(b.title)} · ${esc(b.author)}">
            <span class="face spine">${no}<span class="s-title">${esc(b.title)}</span><span class="s-author">${esc(lastName(b.author).replace(/^./, (x) => x.toUpperCase()))}</span>${stars}</span>
            <span class="face side"${b.cover_id ? ` style="background-image:url('${cover(b)}')"` : ''}></span>
            <span class="face top"></span>
        </button>`;
    }

    // Break a shelf section into rows that fit the room's width, each on its own board.
    function rows(list) {
        // Room padding, bookcase borders and shelf padding (see books.css), plus a little slack.
        const max = $('room').clientWidth - (window.innerWidth < 640 ? 72 : 108) - 4;
        const out = [[]];
        let used = 0;
        for (const b of list) {
            const w = width(b) + 3;
            if (used + w > max && out[out.length - 1].length) { out.push([]); used = 0; }
            out[out.length - 1].push(b);
            used += w;
        }
        return out;
    }

    function render() {
        const html = SHELVES.map(([key, label]) => {
            const list = sorted(books.filter((b) => b.shelf === key));
            if (!list.length) return '';
            return `<section class="bookcase" data-shelf="${key}">
                <h2 class="plaque">${label} <span>${list.length}</span></h2>
                ${rows(list).map((r) => `<div class="shelf"><div class="books">${r.map(bookEl).join('')}</div><div class="board"></div></div>`).join('')}
            </section>`;
        }).join('');
        $('room').innerHTML = html || '<p class="lib-loading">No books yet.</p>';
        applySearch();
        renderStats();
    }

    function renderStats() {
        const read = books.filter((b) => b.shelf === 'read');
        const pages = read.reduce((s, b) => s + (b.pages || 0), 0);
        const counts = {};
        read.forEach((b) => { counts[b.author] = (counts[b.author] || 0) + 1; });
        const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a, n]) => `${a} (${n})`).join(', ');
        $('stats').textContent = `${read.length} read · ~${pages.toLocaleString()} pages · ${books.filter((b) => b.shelf === 'to-read').length} waiting · most read: ${top}`;
    }

    function applySearch() {
        const q = $('search').value.trim().toLowerCase();
        document.querySelectorAll('.book').forEach((el) => {
            const b = byId(el.dataset.id);
            const hit = !q || [b.title, b.author, b.series, b.notes].some((v) => (v || '').toLowerCase().includes(q));
            el.classList.toggle('dim', !hit);
        });
    }

    // ── Detail drawer ───────────────────────────────────────────────────────
    let open = null;
    function show(b) {
        open = b;
        $('d-cover').innerHTML = b.cover_id
            ? `<img src="${cover(b, 'L')}" alt="Cover of ${esc(b.title)}">`
            : `<div class="d-cover-blank" style="--c:${colorOf(b)};--ink:${inkFor(colorOf(b))}"><b>${esc(b.title)}</b><span>${esc(b.author)}</span></div>`;
        $('d-series').textContent = b.series ? `${b.series}${b.series_no ? ` · ${/^\d/.test(b.series_no) ? '#' : ''}${b.series_no}` : ''}` : '';
        $('d-title').textContent = b.title;
        $('d-author').textContent = b.author;
        $('d-meta').textContent = [b.year && `First published ${b.year}`, b.pages && `${b.pages} pages`, b.avg_rating && `Goodreads avg ${b.avg_rating.toFixed(2)}`, b.date_added && `Shelved ${b.date_added}`].filter(Boolean).join(' · ');
        $('d-shelf').value = b.shelf;
        $('d-read').value = b.date_read || '';
        $('d-notes').value = b.notes || b.note || '';
        paintStars();
        paintLinks();
        $('d-remove').textContent = 'Remove book';
        state('');
        $('drawer').hidden = false;
        document.body.classList.add('noscroll');
    }
    function close() {
        if (saveTimer) save();
        $('drawer').hidden = true;
        $('adder').hidden = true;
        document.body.classList.remove('noscroll');
        open = null;
        render();
    }
    document.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', close));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && (!$('drawer').hidden || !$('adder').hidden)) close(); });

    function paintStars() {
        $('d-stars').innerHTML = [1, 2, 3, 4, 5].map((n) => `<button type="button" role="radio" aria-checked="${open.rating === n}" aria-label="${n} star${n > 1 ? 's' : ''}" data-n="${n}" class="${(open.rating || 0) >= n ? 'on' : ''}">★</button>`).join('') +
            `<span class="d-stars-lbl">${open.rating ? 'My rating' : 'Not rated'}</span>`;
    }
    $('d-stars').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-n]');
        if (!btn) return;
        const n = +btn.dataset.n;
        open.rating = open.rating === n ? null : n;
        paintStars();
        queueSave();
    });

    function paintLinks() {
        const links = open.links || [];
        $('d-links').innerHTML = links.length
            ? links.map((l, i) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label || l.url)}</a><button type="button" data-i="${i}" aria-label="Remove link">×</button></li>`).join('')
            : '<li class="muted small">None yet. Paste a Claude or Gemini artifact link below.</li>';
    }
    $('d-links').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-i]');
        if (!btn) return;
        open.links.splice(+btn.dataset.i, 1);
        paintLinks();
        queueSave();
    });
    $('d-link-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const url = $('d-link-url').value.trim();
        if (!/^https?:\/\//i.test(url)) return;
        (open.links ||= []).push({ label: $('d-link-label').value.trim() || 'Link', url });
        $('d-link-label').value = '';
        $('d-link-url').value = '';
        paintLinks();
        queueSave();
    });

    $('d-shelf').addEventListener('change', () => {
        open.shelf = $('d-shelf').value;
        if (open.shelf === 'read' && !open.date_read) { open.date_read = today(); $('d-read').value = open.date_read; }
        queueSave();
    });
    $('d-read').addEventListener('change', () => { open.date_read = $('d-read').value || null; queueSave(); });
    $('d-notes').addEventListener('input', () => { open.notes = $('d-notes').value; delete open.note; queueSave(); });
    $('d-remove').addEventListener('click', () => {
        if ($('d-remove').textContent !== 'Click again to remove') { $('d-remove').textContent = 'Click again to remove'; return; }
        books.splice(books.indexOf(open), 1);
        save();
        close();
    });

    $('room').addEventListener('click', (e) => {
        const el = e.target.closest('.book');
        if (el) show(byId(el.dataset.id));
    });

    // ── Adding books ────────────────────────────────────────────────────────
    $('add-btn').addEventListener('click', () => { $('add-form').reset(); $('adder').hidden = false; document.body.classList.add('noscroll'); $('a-title').focus(); });
    $('add-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const title = $('a-title').value.trim(), author = $('a-author').value.trim();
        let id = `${title} ${author}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
        if (byId(id)) id += `-${Date.now()}`;
        const b = {
            id, title, author, series: $('a-series').value.trim() || null, series_no: $('a-no').value.trim() || null,
            shelf: $('a-shelf').value, date_added: today(), date_read: $('a-shelf').value === 'read' ? today() : null,
            rating: null, avg_rating: null, notes: '', links: []
        };
        try {
            const q = new URLSearchParams({ title, author, limit: '1', fields: 'key,cover_i,number_of_pages_median,first_publish_year' });
            const doc = (await (await fetch(`https://openlibrary.org/search.json?${q}`)).json()).docs[0];
            if (doc) Object.assign(b, { cover_id: doc.cover_i || null, pages: doc.number_of_pages_median || null, year: doc.first_publish_year || null, ol_key: doc.key });
        } catch (_) { /* shelve it without a cover */ }
        books.push(b);
        await save();
        $('adder').hidden = true;
        render();
        show(b);
    });

    $('search').addEventListener('input', applySearch);
    $('sort').addEventListener('change', render);
    let resizeTimer;
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); });
    window.addEventListener('beforeunload', () => { if (saveTimer) save(); });

    render();
})();
