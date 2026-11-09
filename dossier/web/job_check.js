// Job Check: one 10x10 grid reused all week, like the paper version. Each weekday has its own mark;
// clicking a square toggles today's mark there and saves right away to job-check.json in the dossier store.
// Data: { days: { "YYYY-MM-DD": [square numbers 1-100] } }, so every past week is kept.
(async function () {
    const $ = (id) => document.getElementById(id);
    const FILE = '/dossier/api/files/job-check.json';
    // Monday-first, matching the work week.
    const DAYS = [
        ['Mon', '✕', '#a62a20'], ['Tue', '○', '#2b5d8a'], ['Wed', '△', '#2f7a3a'], ['Thu', '□', '#7a4a9a'],
        ['Fri', '◇', '#b86a12'], ['Sat', '☆', '#5d5447'], ['Sun', '+', '#5d5447'],
    ];
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

    const grid = $('grid');
    for (let n = 1; n <= 100; n++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.n = n;
        grid.append(b);
    }

    function render() {
        const dates = weekDates();
        const todayIdx = dates.indexOf(iso(new Date()));
        $('legend').innerHTML = DAYS.map(([name, sym, color], i) => {
            const count = (data.days[dates[i]] || []).length;
            return `<span class="${i === todayIdx ? 'today' : ''}" style="color:${color}">${sym} ${name} ${count}</span>`;
        }).join('');
        for (const b of grid.children) {
            const n = Number(b.dataset.n);
            const marks = DAYS.map(([name, sym, color], i) => (data.days[dates[i]] || []).includes(n)
                ? `<span class="m" style="color:${color}">${sym}</span>` : '').join('');
            b.innerHTML = `<span class="n">${n}</span>${marks}`;
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

    grid.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const n = Number(b.dataset.n);
        const today = iso(new Date()); // read on every click so a page left open overnight marks the right day
        const list = data.days[today] || [];
        data.days[today] = list.includes(n) ? list.filter((x) => x !== n) : [...list, n].sort((a, b) => a - b);
        if (!data.days[today].length) delete data.days[today];
        render();
        save();
    });

    render();
    state('Ready. Click a square for each application.');
})();
