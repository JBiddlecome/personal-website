// Daily field log: one private file per day (journal-YYYY-MM-DD.json) in the dossier file store.
(async function () {
    const $ = (id) => document.getElementById(id);
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fileUrl = (name) => `/dossier/api/files/${encodeURIComponent(name)}`;
    const fileFor = (date) => `journal-${date}.json`;
    const NAME_RE = /^journal-(\d{4}-\d{2}-\d{2})\.json$/;
    const today = () => { const n = new Date(); return new Date(n - n.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
    const pretty = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();

    // Rotating questions, picked by date so a given day always shows the same one. The personal set
    // lives in private storage (journal-prompts.json, uploaded by publish.js); these are the fallback.
    let PROMPTS = [
        'What did you do today that moved a goal forward?',
        'What did you fix, build or improve today, however small?',
        'What are you reading, and what idea from it stuck with you?',
        'What would make tomorrow 10% better?',
        'When did you feel most like yourself today?',
        'What drained your energy today, and what restored it?',
        'What did you learn today: a skill, a fact, a tool?',
        'What are you avoiding right now, and what is the smallest first step?',
        'Where did you leave something better than you found it today?',
        'What are you grateful for that you usually take for granted?'
    ];
    const promptFor = (date) => PROMPTS[Math.floor(new Date(date + 'T00:00:00') / 864e5) % PROMPTS.length];

    $('logout').addEventListener('click', async () => {
        await fetch('/dossier/api/logout', { method: 'POST' }).catch(() => {});
        location.href = '/dossier';
    });

    // 1–5 scales rendered as stamp buttons.
    const scales = {};
    document.querySelectorAll('.scale').forEach((el) => {
        const field = el.dataset.field;
        for (let i = 1; i <= 5; i++) el.insertAdjacentHTML('beforeend', `<button type="button" data-v="${i}" aria-label="${field} ${i}">${i}</button>`);
        el.addEventListener('click', (e) => {
            const b = e.target.closest('button');
            if (!b) return;
            scales[field] = scales[field] === +b.dataset.v ? null : +b.dataset.v;
            paintScale(el, scales[field]);
            changed();
        });
    });
    const paintScale = (el, v) => el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', +b.dataset.v === v));

    const TEXT_FIELDS = ['exercise', 'body', 'win', 'struggle', 'tags'];
    let current = null;      // date being edited
    let dirty = false;
    let timer = null;
    const entries = new Map(); // date -> entry (loaded ones)

    function collect() {
        const e = { date: current, prompt: promptFor(current), prompt_answer: $('prompt-answer').value.trim() };
        e.mood = scales.mood ?? null;
        e.energy = scales.energy ?? null;
        e.sleep_hours = $('sleep').value === '' ? null : Number($('sleep').value);
        for (const f of TEXT_FIELDS) e[f] = $(f).value.trim();
        e.tags = e.tags ? e.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
        e.updated_at = new Date().toISOString();
        return e;
    }
    const isEmpty = (e) => !e.mood && !e.energy && e.sleep_hours === null && !e.prompt_answer && !e.tags.length &&
        ['exercise', 'body', 'win', 'struggle'].every((f) => !e[f]);

    function fill(date, e) {
        current = date;
        $('date').value = date;
        $('entry-kicker').textContent = date === today() ? 'DAILY OBSERVATION · TODAY' : `DAILY OBSERVATION · ${pretty(date)}`;
        $('prompt-text').textContent = (e && e.prompt) || promptFor(date);
        scales.mood = e?.mood ?? null;
        scales.energy = e?.energy ?? null;
        document.querySelectorAll('.scale').forEach((el) => paintScale(el, scales[el.dataset.field]));
        $('sleep').value = e?.sleep_hours ?? '';
        for (const f of TEXT_FIELDS) $(f).value = f === 'tags' ? (e?.tags || []).join(', ') : (e?.[f] || '');
        $('prompt-answer').value = e?.prompt_answer || '';
        dirty = false;
        state(e ? `FILED ${new Date(e.updated_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'NEW ENTRY');
        markActive();
    }

    function state(text, cls = '') { const s = $('save-state'); s.textContent = text; s.className = `save-state ${cls}`; }

    function changed() {
        dirty = true;
        state('UNSAVED', 'warn');
        clearTimeout(timer);
        timer = setTimeout(save, 2000);
    }

    async function save() {
        clearTimeout(timer);
        if (!dirty || !current) return;
        const e = collect();
        if (isEmpty(e) && !entries.has(current)) { dirty = false; state('NEW ENTRY'); return; }
        state('FILING…');
        try {
            const res = await fetch(fileUrl(fileFor(current)), { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(e, null, 2) });
            if (res.status === 401) { location.href = '/dossier'; return; }
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
            entries.set(current, e);
            dirty = false;
            state(`FILED ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, 'ok');
            renderIndex();
        } catch (err) {
            state(`NOT SAVED: ${err.message}`, 'warn');
        }
    }

    async function load(date) {
        if (dirty) await save();
        if (entries.has(date)) { fill(date, entries.get(date)); return; }
        const res = await fetch(fileUrl(fileFor(date)), { cache: 'no-store' });
        if (res.ok) { const e = await res.json(); entries.set(date, e); fill(date, e); } else fill(date, null);
    }

    // ── Index: list, stats, mood line ───────────────────────────────────────
    let dates = [];
    function renderIndex() {
        dates = [...new Set([...dates, ...entries.keys()])].sort().reverse();
        const set = new Set(dates);
        let streak = 0;
        for (let d = new Date(today() + 'T00:00:00'); set.has(d.toISOString().slice(0, 10)); d.setDate(d.getDate() - 1)) streak++;
        $('stats').innerHTML = `<div><b>${dates.length}</b>entries</div><div><b>${streak}</b>day streak</div>`;

        $('list').innerHTML = dates.length ? dates.map((d) => {
            const e = entries.get(d);
            const meta = e ? [e.mood && `mood ${e.mood}`, e.energy && `energy ${e.energy}`].filter(Boolean).join(' · ') : '';
            return `<li><a href="#${d}" data-date="${d}">${esc(pretty(d))}${meta ? `<span class="muted small">${esc(meta)}</span>` : ''}</a></li>`;
        }).join('') : '<li class="muted small">No entries yet. Today is a good day to start.</li>';
        markActive();

        // Mood over the last 30 entries, oldest on the left.
        const pts = dates.slice(0, 30).reverse().map((d) => entries.get(d)?.mood).map((m, i, a) => m ? [a.length < 2 ? 150 : (i / (a.length - 1)) * 300, 55 - (m - 1) * 12.5] : null).filter(Boolean);
        $('moodline').innerHTML = pts.length > 1
            ? `<polyline fill="none" stroke="#a62a20" stroke-width="2" vector-effect="non-scaling-stroke" points="${pts.map((p) => p.join(',')).join(' ')}"/>`
            : '';
    }
    function markActive() { document.querySelectorAll('#list a').forEach((a) => a.classList.toggle('active', a.dataset.date === current)); }

    $('list').addEventListener('click', (e) => {
        const a = e.target.closest('a[data-date]');
        if (!a) return;
        e.preventDefault();
        history.replaceState(null, '', `#${a.dataset.date}`);
        load(a.dataset.date);
    });
    $('date').addEventListener('change', () => { if ($('date').value) { history.replaceState(null, '', `#${$('date').value}`); load($('date').value); } });
    document.querySelectorAll('.log-entry input:not(#date), .log-entry textarea').forEach((el) => el.addEventListener('input', changed));
    $('save').addEventListener('click', () => { dirty = true; save(); });
    document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); dirty = true; save(); } });
    window.addEventListener('beforeunload', (e) => { if (dirty) { save(); e.preventDefault(); } });

    // Initial load: personal prompts, then the file list and the 30 most recent entries for stats.
    try {
        const r = await fetch(fileUrl('journal-prompts.json'), { cache: 'no-store' });
        if (r.ok) { const list = await r.json(); if (Array.isArray(list) && list.length) PROMPTS = list; }
    } catch (_) { /* keep the fallback prompts */ }
    try {
        const res = await fetch('/dossier/api/files', { cache: 'no-store' });
        if (res.status === 401) { location.href = '/dossier'; return; }
        const { files } = await res.json();
        dates = files.map((f) => (f.name.match(NAME_RE) || [])[1]).filter(Boolean).sort().reverse();
        await Promise.all(dates.slice(0, 30).map(async (d) => {
            const r = await fetch(fileUrl(fileFor(d)), { cache: 'no-store' });
            if (r.ok) entries.set(d, await r.json());
        }));
    } catch (err) {
        state(`INDEX UNAVAILABLE: ${err.message}`, 'warn');
    }
    renderIndex();
    const start = /^#\d{4}-\d{2}-\d{2}$/.test(location.hash) ? location.hash.slice(1) : today();
    await load(start);
})();
