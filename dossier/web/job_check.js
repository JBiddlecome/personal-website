// Job Check: one 10x10 grid reused all week, like the paper version. Each weekday has its own mark;
// clicking a square toggles the picked day's mark there (today unless a past day in the legend is clicked; reload resets to today) and saves right away to job-check.json in the dossier store.
// Data: { days: { "YYYY-MM-DD": [square numbers 1-100] } }, so every past week is kept.
(async function () {
    const $ = (id) => document.getElementById(id);
    const FILE = '/dossier/api/files/job-check.json';
    // Monday-first, matching the work week.
    // Marks are SVG paths (0-100 box), not font glyphs, so every day draws with the same line weight.
    const DAYS = [
        ['Mon', 'M22 22L78 78M78 22L22 78', '#a62a20'],
        ['Tue', 'M50 18a32 32 0 1 0 0.01 0', '#2b5d8a'],
        ['Wed', 'M50 16L84 80H16Z', '#2f7a3a'],
        ['Thu', 'M20 20H80V80H20Z', '#7a4a9a'],
        ['Fri', 'M50 12L88 50L50 88L12 50Z', '#b86a12'],
        ['Sat', 'M50 12L59 38H87L64 55L73 82L50 66L27 82L36 55L13 38H41Z', '#5d5447'],
        ['Sun', 'M50 15V85M15 50H85', '#5d5447'],
    ];
    const PAST = '#b9b2a6';
    const mark = (d, color, w) => `<svg viewBox="0 0 100 100" aria-hidden="true"><path d="${d}" stroke="${color}" stroke-width="${w}"/></svg>`;
    const iso = (d) => new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
    const weekDates = () => {
        const now = new Date();
        const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getDay() + 6) % 7);
        return DAYS.map((_, i) => iso(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)));
    };
    const state = (t, err) => { $('state').textContent = t; $('state').className = 'jc-state' + (err ? ' err' : ''); };

    $('logout').addEventListener('click', async () => {
        await fetch('/dossier/api/logout', { method: 'POST' }).catch(() => {});
        location.href = '/dossier';
    });

    let data;
    try {
        const res = await fetch(FILE, { cache: 'no-store' });
        if (res.status === 401) { location.href = '/dossier'; return; }
        if (res.status === 404) data = { days: {} };
        else if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
        else data = await res.json();
    } catch (err) {
        // Don't render a clickable grid: saving over an unread file would erase past weeks.
        state(`Could not load your grid: ${err.message}. Reload to try again.`, true);
        return;
    }

    let picked = null; // index of a past weekday picked in the legend; null = today
    const grid = $('grid');
    for (let n = 1; n <= 100; n++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.n = n;
        grid.append(b);
    }

    function render() {
        const dates = weekDates();
        const todayIdx = picked ?? dates.indexOf(iso(new Date())); // the active day: drawn in color, gets the clicks
        const realToday = dates.indexOf(iso(new Date()));
        $('legend').innerHTML = DAYS.map(([name, sym, color], i) => {
            const count = (data.days[dates[i]] || []).length;
            return `<button type="button" data-i="${i}" class="${i === todayIdx ? 'today' : ''}" aria-pressed="${i === todayIdx}"${i > realToday ? ' disabled' : ''} style="color:${color}">${mark(sym, color, 10)} ${name} ${count}</button>`;
        }).join('');
        for (const b of grid.children) {
            const n = Number(b.dataset.n);
            // Earlier days: thin and gray underneath. Today: thick, in its color, drawn last so it sits on top.
            const marks = DAYS.map(([name, sym, color], i) => (data.days[dates[i]] || []).includes(n)
                ? `<span class="m">${i === todayIdx ? mark(sym, color, 11) : mark(sym, PAST, 5)}</span>` : '');
            if (todayIdx >= 0) marks.push(marks.splice(todayIdx, 1)[0]);
            b.innerHTML = `<span class="n">${n}</span>${marks.join('')}`;
            const on = DAYS.filter((_, i) => (data.days[dates[i]] || []).includes(n)).map(([name]) => name);
            b.setAttribute('aria-label', `Square ${n}${on.length ? ', marked ' + on.join(', ') : ''}`);
        }
    }

    // Saves run one at a time, each sending the latest state, so fast clicks can't land out of order.
    let chain = Promise.resolve();
    function save() {
        state('Saving…');
        chain = chain.then(async () => {
            try {
                const res = await fetch(FILE, { method: 'PUT', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(data) });
                if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
                state(`Saved ${new Date().toLocaleTimeString()}`);
            } catch (err) {
                state(`Not saved: ${err.message}. They'll save with your next click.`, true);
            }
        });
    }

    // The /apply skill also marks squares (dossier/job-check-mark.js), so re-read the file before each change;
    // otherwise a page left open would save its old copy over those marks.
    async function refresh() {
        try {
            const res = await fetch(FILE, { cache: 'no-store' });
            if (res.ok) data = await res.json();
        } catch (_) { /* keep the copy we have; the save below reports any real problem */ }
    }

    grid.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const n = Number(b.dataset.n);
        // Today is read on every click so a page left open overnight marks the right day.
        const today = picked === null ? iso(new Date()) : weekDates()[picked];
        chain = chain.then(async () => {
            await refresh();
            const list = data.days[today] || [];
            data.days[today] = list.includes(n) ? list.filter((x) => x !== n) : [...list, n].sort((a, b) => a - b);
            if (!data.days[today].length) delete data.days[today];
            render();
        });
        save();
    });

    // Show marks the skill added while this tab sat in the background.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') chain = chain.then(async () => { await refresh(); render(); });
    });

    $('legend').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const i = Number(b.dataset.i);
        picked = i === weekDates().indexOf(iso(new Date())) ? null : i;
        render();
        state(picked === null ? 'Marking today.' : `Marking ${DAYS[i][0]} ${weekDates()[i]}. Reload or click today to go back.`);
    });

    render();
    state('Ready. Click a square for each application.');
})();
