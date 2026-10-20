// Renders the subject file from dossier.json (served from private storage, never from this repo).
(async function () {
    const main = document.getElementById('file');

    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const pending = (v, label = 'PENDING') => (v === null || v === undefined || v === '') ? `<span class="redact">${label}</span>` : esc(v);
    const fileUrl = (name) => `/dossier/api/files/${encodeURIComponent(name)}`;

    document.getElementById('logout').addEventListener('click', async () => {
        await fetch('/dossier/api/logout', { method: 'POST' }).catch(() => {});
        location.href = '/dossier';
    });

    let d;
    try {
        const res = await fetch(fileUrl('dossier.json'), { cache: 'no-store' });
        if (res.status === 401) { location.reload(); return; }
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
        d = await res.json();
    } catch (err) {
        main.innerHTML = `<p class="error-box">FILE COULD NOT BE RETRIEVED — ${esc(err.message)}</p>`;
        return;
    }

    const s = d.subject;
    const age = (() => {
        const b = new Date(s.dob + 'T00:00:00'), n = new Date();
        return n.getFullYear() - b.getFullYear() - ((n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) ? 1 : 0);
    })();
    const fmtDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }).toUpperCase();
    const feet = (inches) => `${Math.floor(inches / 12)}′${inches % 12}″`;

    document.getElementById('file-no').textContent = `FILE No. ${d.meta.file_no}`;
    document.title = `File ${d.meta.file_no}`;

    const sheet = (id, n, kicker, title, body, stamp = '', tab = title) => `
        <section class="sheet" id="${id}" data-tab="${esc(tab)}">
            <div class="sheet-head">
                <div><div class="kicker">${esc(kicker)}</div><h2><span class="sec">§${n}</span>${esc(title)}</h2></div>
                ${stamp}
            </div>
            ${body}
        </section>`;

    // ── Body outline on a mugshot height chart ──────────────────────────────
    function figure() {
        const K = 5.6, GROUND = 462, y = (inch) => GROUND - inch * K;
        let chart = '';
        for (let inch = 6; inch <= 78; inch += 3) {
            const major = inch % 12 === 0;
            chart += `<line x1="${major ? 0 : 12}" x2="260" y1="${y(inch)}" y2="${y(inch)}" stroke="#1f1b16" stroke-opacity="${major ? 0.35 : 0.12}" stroke-width="${major ? 1 : 0.7}"/>`;
            if (major) chart += `<text x="2" y="${y(inch) - 3}" font-size="9" fill="#5d5447" font-family="Special Elite">${feet(inch)}</text>`;
        }
        const limbs = [
            'M86 130 L74 205 L66 285', 'M174 130 L186 205 L194 285',
            'M115 282 L113 370 L112 448', 'M145 282 L147 370 L148 448'
        ];
        const torso = 'M88 124 Q130 114 172 124 L168 190 Q162 238 160 262 L164 292 L96 292 L100 262 Q98 238 92 190 Z';
        const layer = (stroke, wArm, wLeg, wTorso) =>
            limbs.map((p, i) => `<path d="${p}" fill="none" stroke="${stroke}" stroke-width="${i < 2 ? wArm : wLeg}" stroke-linecap="round" stroke-linejoin="round"/>`).join('') +
            `<path d="${torso}" fill="${stroke}" stroke="${stroke}" stroke-width="${wTorso}" stroke-linejoin="round"/>` +
            `<rect x="${123 - (wTorso / 2)}" y="110" width="${14 + wTorso}" height="20" fill="${stroke}"/>` +
            `<ellipse cx="130" cy="97" rx="${17 + wTorso / 2}" ry="${21 + wTorso / 2}" fill="${stroke}"/>` +
            `<ellipse cx="108" cy="455" rx="${10 + wTorso / 2}" ry="${5 + wTorso / 2}" fill="${stroke}"/><ellipse cx="152" cy="455" rx="${10 + wTorso / 2}" ry="${5 + wTorso / 2}" fill="${stroke}"/>`;
        const top = y(s.height_in);
        const marks = (s.body_map || []).map((m) => {
            const dots = [[m.x, m.y], ...(m.also ? [m.also] : [])];
            return dots.map(([x, yy], i) => `<circle cx="${x}" cy="${yy}" r="7" fill="#a62a20" fill-opacity="0.9"/>${i === 0 ? `<text x="${x}" y="${yy + 3.2}" font-size="9" text-anchor="middle" fill="#f1e9d4" font-family="Special Elite">${m.n}</text>` : ''}`).join('');
        }).join('');
        return `
            <div class="figure">
                <svg viewBox="0 0 260 470" role="img" aria-label="Body outline, ${feet(s.height_in)}, ${s.weight_lb} pounds, with marked features">
                    ${chart}
                    <g>${layer('#1f1b16', 22, 26, 4)}${layer('#f1e9d4', 18, 22, 0)}</g>
                    <line x1="40" x2="250" y1="${top}" y2="${top}" stroke="#a62a20" stroke-dasharray="4 3" stroke-width="1.2"/>
                    <text x="250" y="${top - 4}" font-size="11" text-anchor="end" fill="#a62a20" font-family="Special Elite">${feet(s.height_in)} · ${s.weight_lb} LB</text>
                    ${marks}
                    <text x="130" y="468" font-size="7" text-anchor="middle" fill="#5d5447" font-family="Special Elite">ANTERIOR VIEW · SUBJECT'S LEFT IS VIEWER'S RIGHT</text>
                </svg>
                <ol class="legend">${(s.body_map || []).map((m) => `<li><b>${m.n}</b><span>${esc(m.label)}</span></li>`).join('')}</ol>
            </div>`;
    }

    // ── §1 Subject profile ──────────────────────────────────────────────────
    const profile = sheet('profile', 1, `FILE OPENED ${fmtDate(d.meta.opened)}`, 'Subject Profile', `
        <div class="cover-top">
            <div class="photo">
                <span class="clip" aria-hidden="true"></span>
                <img src="${fileUrl(s.photo)}" alt="Portrait of ${esc(s.goes_by)}">
                <span class="cap">SPECIMEN PHOTOGRAPH</span>
            </div>
            ${figure()}
            <div class="card">
                <div class="name-block">
                    <div class="surname">${esc(s.surname)},</div>
                    <div class="given">${esc(s.given)}</div>
                    <div class="aka">a.k.a. “${esc(s.goes_by)}” · ${s.aliases.length} recorded aliases</div>
                </div>
                <table class="fields">
                    <tr><th>Born</th><td>${esc(fmtDate(s.dob))} <span class="muted">(age ${age})</span></td></tr>
                    <tr><th>Birthplace</th><td>${esc(s.pob)}</td></tr>
                    <tr><th>Sex</th><td>${esc(s.sex)}</td></tr>
                    <tr><th>Height / Weight</th><td>${feet(s.height_in)} · ${s.weight_lb} lb</td></tr>
                    <tr><th>Eyes / Hair</th><td>${esc(s.eyes)} · ${esc(s.hair)} · ${esc(s.facial_hair)}</td></tr>
                    <tr><th>Handedness</th><td>${esc(s.handedness)}</td></tr>
                    <tr><th>Sizes</th><td>${esc(s.sizes)}</td></tr>
                    <tr><th>Residence</th><td>${esc(s.address)} <span class="muted">(since ${esc(s.address_since)})</span></td></tr>
                    <tr><th>Email</th><td>${pending(s.email)}</td></tr>
                    <tr><th>Phone</th><td>${pending(s.phone)}</td></tr>
                    <tr><th>Marital status</th><td>${esc(s.marital)}${s.spouse ? ` — ${esc(s.spouse)}` : ' — spouse: <span class="redact">PENDING</span>'}</td></tr>
                    <tr><th>Occupation</th><td>${pending(s.occupation, 'PENDING §D')}</td></tr>
                    <tr><th>Religion</th><td>${esc(s.religion)}</td></tr>
                </table>
            </div>
        </div>
        <div class="cover-meta">
            <span>FILE <b>${esc(d.meta.file_no)}</b></span>
            <span>STATUS <b>${esc(d.meta.status)}</b></span>
            <span>SESSIONS <b>${d.meta.sessions}</b></span>
            <span>LAST ENTRY <b>${esc(fmtDate(d.meta.updated))}</b></span>
        </div>
        <p class="summary">${esc(d.summary)}</p>
        <h3>Known aliases</h3>
        <div class="alias-grid">${s.aliases.map((a) => `<div class="alias"><b>${esc(a.name)}</b>${esc(a.context)}</div>`).join('')}</div>
        <h3>Distinguishing marks</h3>
        <table class="kv">${s.marks.map((m) => `<tr><th>${esc(m.label)}</th><td>${esc(m.where)}${m.note ? ` — <span class="muted">${esc(m.note)}</span>` : ''}</td></tr>`).join('')}</table>
    `, '<span class="stamp big">RESTRICTED</span>', 'Profile');

    // ── §2 Origin & family ──────────────────────────────────────────────────
    const person = (p) => {
        const cls = ['person', p.subject && 'subject', p.status].filter(Boolean).join(' ');
        const tag = p.status === 'estranged' ? '<span class="stamp small">ESTRANGED</span>' : '';
        return `<div class="${cls}">${tag}<div class="rel">${esc(p.relation)}</div><div class="nm">${esc(p.name)}</div>${p.detail ? `<div>${esc(p.detail)}</div>` : ''}${p.status_note ? `<div class="muted small">${esc(p.status_note)}</div>` : ''}</div>`;
    };
    const origin = sheet('origin', 2, 'LINEAGE & KNOWN ASSOCIATES', 'Origin & Family', `
        <p class="summary" style="margin-top:0">${esc(d.family.note)}</p>
        <h3>Pedigree</h3>
        <div class="tree">${d.family.generations.map((g) => `<div class="gen"><div class="gen-label">${esc(g.label)}</div><div class="gen-row">${g.people.map(person).join('')}</div></div>`).join('')}</div>
        <h3>Early associates</h3>
        <div class="gen-row others" style="justify-content:flex-start">${d.family.others.map(person).join('')}</div>
    `, '', 'Family');

    // ── §3 Physical & medical ───────────────────────────────────────────────
    const p = d.physical;
    const Y0 = 2005, Y1 = 2027, span = Y1 - Y0;
    const pct = (yr) => ((Math.min(Math.max(yr, Y0), Y1) - Y0) / span) * 100;
    const ticks = [2005, 2010, 2015, 2020, 2025].map((yr) => `<span style="left:${pct(yr)}%">${yr}</span>`).join('');
    const substances = p.substances.map((x) => {
        const to = x.to === 2026 ? 2026.55 : x.to + 0.4;
        return `<div class="subst-row"><span>${esc(x.what)}</span><div class="subst-track"><div class="subst-bar quit" style="left:${pct(x.from)}%;width:${pct(to) - pct(x.from)}%" title="${esc(`${x.from}–${x.to}${x.note ? ': ' + x.note : ''}`)}"></div></div></div>`;
    }).join('');
    const physical = sheet('physical', 3, 'BIOLOGICAL OBSERVATIONS', 'Physical & Medical', `
        <div class="two-col">
            <div><h3 style="margin-top:0">Vitals & habits</h3><table class="kv">${p.vitals.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table></div>
            <div><h3 style="margin-top:0">Conditions & care</h3><table class="kv">${p.conditions.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table></div>
        </div>
        <h3>Diet</h3>
        <p>${esc(p.diet)}</p>
        <h3>Substance history</h3>
        <div class="subst">
            ${substances}
            <div class="subst-axis"><span></span><div class="subst-ticks">${ticks}</div></div>
        </div>
        <ul class="subst-notes">${p.substances.filter((x) => x.note).map((x) => `<li>${esc(x.what)} (${x.from}–${x.to}): ${esc(x.note)}</li>`).join('')}</ul>
        <span class="clean-tag">CURRENT STATUS: NO NICOTINE · NO ALCOHOL · NO CANNABIS · NO MEDICATIONS</span>
        <h3>Family medical history</h3>
        <table class="kv">${p.family_history.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>
    `, '', 'Physical');

    // ── §4 Residences & education ───────────────────────────────────────────
    const when = (r) => r.to ? `${esc(r.from)}–${esc(r.to)}` : esc(r.from);
    const residences = sheet('residences', 4, `${d.residences.length} KNOWN HABITATS`, 'Residences & Education', `
        <ol class="timeline">${d.residences.map((r) => `
            <li class="${[r.aside && 'aside', r.current && 'current'].filter(Boolean).join(' ')}">
                <span class="when">${when(r)}</span>
                <div class="place">${esc(r.place)}</div>
                ${r.with ? `<div class="with">WITH: ${esc(r.with)}</div>` : ''}
                ${r.detail ? `<div class="detail">${esc(r.detail)}</div>` : ''}
            </li>`).join('')}
        </ol>
        <h3>Schooling</h3>
        <div class="edu">${d.education.map((e) => `<div><span class="lvl">${esc(e.level)} · ${esc(e.years)}</span><b>${esc(e.school)}</b>${esc(e.place)}${e.note ? `<div class="muted small" style="margin-top:.25rem">${esc(e.note)}</div>` : ''}</div>`).join('')}</div>
    `, '', 'Places');

    // ── §5 Career ───────────────────────────────────────────────────────────
    const jobs = d.career || [];
    const career = sheet('career', 5, `${jobs.length} RECORDED OCCUPATIONS`, 'Career', `
        <ol class="timeline">${jobs.map((j) => `
            <li class="${[j.minor && 'aside', j.current && 'current', j.major && 'major'].filter(Boolean).join(' ')}">
                <span class="when">${when(j)}</span>
                <div class="place">${esc(j.org)} <span class="muted small">· ${esc(j.place)}</span></div>
                <div class="with">${esc(j.role)}</div>
                ${j.note ? `<div class="detail">${esc(j.note)}</div>` : ''}
            </li>`).join('')}
        </ol>
    `, '', 'Career');

    // ── §6 Relationships ────────────────────────────────────────────────────
    const partners = d.relationships || [];
    const relationships = sheet('relationships', 6, `${partners.length} RECORDED ATTACHMENTS`, 'Relationships', `
        <ol class="timeline">${partners.map((r) => `
            <li class="${[r.current && 'current', r.major && 'major'].filter(Boolean).join(' ')}">
                <span class="when">${when(r)}</span>
                <div class="place">${esc(r.name)} <span class="muted small">· ${esc(r.where)}</span></div>
                ${r.note ? `<div class="detail">${esc(r.note)}</div>` : ''}
            </li>`).join('')}
        </ol>
        ${(d.people || []).length ? `
        <h3>Known associates</h3>
        <table class="kv">${d.people.map((p) => `<tr><th>${esc(p.name)}<div class="muted small">${esc(p.role)}</div></th><td><b>${esc(p.status)}.</b> ${esc(p.note)}</td></tr>`).join('')}</table>` : ''}
    `, '<span class="stamp">PERSONAL</span>', 'Bonds');

    // ── §7 Personality ──────────────────────────────────────────────────────
    const pers = d.personality;
    const personality = pers ? sheet('personality', 7, pers.instrument.toUpperCase(), 'Personality', `
        <div class="bars">${pers.domains.map((x) => `<div class="bar-row"><span>${esc(x.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${((x.score - 24) / 96) * 100}%"></div></div><span class="pct">${x.score}</span></div>`).join('')}</div>
        <p class="muted small" style="margin-top:.4rem">Domain scores run 24–120. ${esc(pers.note)}</p>
        <h3>Facets · 4–20 each</h3>
        <div class="traits">${pers.domains.map((x) => `<div class="trait-card"><h5>${esc(x.name)} · ${esc(x.band)}</h5><table>${x.facets.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('')}</table></div>`).join('')}</div>
        <h3>Observer's reading</h3>
        <ul>${pers.readings.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
        ${pers.values ? `
        <h3>Values · ${esc(pers.values.instrument)}</h3>
        <div class="bars">${pers.values.scores.map(([k, v, c]) => `<div class="bar-row"><span>${esc(k)}</span><div class="bar-track"><div class="bar-fill" style="width:${((v - 1) / 4) * 100}%"></div></div><span class="pct">${c > 0 ? '+' : ''}${c.toFixed(1)}</span></div>`).join('')}</div>
        <p class="muted small" style="margin-top:.4rem">Bars show the 1–5 rating; the number is relative to his own average (${pers.values.mean.toFixed(2)}), which is how values are compared.</p>
        <ul>${pers.values.readings.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    `, '', 'Psyche') : '';

    // ── §8 Interior ─────────────────────────────────────────────────────────
    const inner = d.interior;
    const interior = inner ? sheet('interior', 8, 'BELIEFS, HABITS & INTERESTS', 'Interior', `
        <div class="two-col">
            <div><h3 style="margin-top:0">Creed</h3><table class="kv">${inner.creed.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table></div>
            <div><h3 style="margin-top:0">Interests</h3><table class="kv">${inner.interests.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table></div>
        </div>
        <h3>A typical day</h3>
        <p>${esc(inner.day)}</p>
        ${inner.projects ? `<h3>Projects</h3><table class="kv">${inner.projects.map((p) => `<tr><th>${esc(p.name)}<div class="muted small">${esc(p.status)}</div></th><td>${esc(p.note)}${(p.links || []).filter((l) => /^https?:\/\//.test(l.url)).map((l) => ` <a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>`).join(' ·')}</td></tr>`).join('')}</table>` : ''}
        ${inner.goals ? `<h3>Stated objectives</h3><table class="kv">${inner.goals.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>` : ''}
    `, '', 'Interior') : '';

    // ── §9 Turning points ───────────────────────────────────────────────────
    const turning = sheet('turning', 9, 'CASE NARRATIVES', 'Turning Points', d.turning_points.map((t) => `
        <article class="case">
            <div class="case-head"><h4>${esc(t.title)}</h4><span class="period">${esc(t.period)}</span></div>
            ${t.paragraphs.map((x) => `<p>${esc(x)}</p>`).join('')}
            ${t.quote ? `<blockquote class="index-card">“${esc(t.quote)}”<cite>— Subject, Oct 2026</cite></blockquote>` : ''}
        </article>`).join(''), '<span class="stamp">SENSITIVE</span>', 'Pivots');

    // ── §10 Genome ───────────────────────────────────────────────────────────
    const g = d.dna;
    const maxPct = Math.max(...g.recent.map(([, v]) => v));
    const genome = sheet('genome', 10, g.source.toUpperCase(), 'Genome & Ancestry', `
        <div class="two-col">
            <div>
                <h3 style="margin-top:0">Recent ancestry · last ~5 generations</h3>
                <div class="bars">${g.recent.map(([k, v]) => `<div class="bar-row"><span>${esc(k)}</span><div class="bar-track"><div class="bar-fill" style="width:${(v / maxPct) * 100}%"></div></div><span class="pct">${v.toFixed(1)}%</span></div>`).join('')}</div>
            </div>
            <div>
                <h3 style="margin-top:0">Deep ancestry · thousands of years</h3>
                <div class="stack">${g.deep.map(([k, v]) => `<span style="width:${v}%" title="${esc(k)} ${v}%"></span>`).join('')}</div>
                <ul class="stack-legend">${g.deep.map(([k, v], i) => `<li><i style="background:${['#1f1b16', '#a62a20', '#8c8170', '#d6c7a0'][i]}"></i>${esc(k)} ${v}%</li>`).join('')}</ul>
                <h3>Lineages</h3>
                <div class="haplo">
                    ${[['Maternal · mtDNA', g.maternal], ['Paternal · Y-DNA', g.paternal]].map(([lbl, h]) => `
                        <div><div class="lbl">${lbl}</div><div class="grp">${esc(h.group)}</div><div class="path">${esc(h.path)}</div><p>${esc(h.note)}</p><p class="muted small" style="margin-top:.3rem">Shared with: ${esc(h.famous)}</p></div>`).join('')}
                </div>
            </div>
        </div>
        <h3>Genetic trait readings</h3>
        <div class="traits">${g.traits.map((t) => `<div class="trait-card"><h5>${esc(t.group)}</h5><table>${t.items.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table></div>`).join('')}</div>
        <p class="caveat">✓ = matches what the subject reported. ${esc(g.caveat)}</p>
    `, '', 'Genome');

    // ── §11 Personal effects ────────────────────────────────────────────────
    const art = d.artifacts;
    const effects = art ? sheet('effects', 11, `${art.items.length} EXHIBITS`, 'Personal Effects', `
        <p class="muted small">${esc(art.note)}</p>
        <div class="evidence">${art.items.map((x, i) => `
            <figure><a href="${fileUrl(x.file)}" target="_blank" rel="noopener"><img src="${fileUrl(x.file)}" alt="${esc(x.title)}" loading="lazy"></a>
                <figcaption><b>EXHIBIT ${String.fromCharCode(65 + i)} · ${esc(x.title)}</b>${esc(x.caption)}</figcaption></figure>`).join('')}
        </div>
    `, '', 'Effects') : '';

    // ── §12 Outstanding inquiries ────────────────────────────────────────────
    const inquiries = sheet('inquiries', 12, 'FIELD WORK REMAINING', 'Outstanding Inquiries', `
        <ul class="inq">${d.inquiries.map((q) => `<li><span class="box">${esc(q.section)}</span><div><b>${esc(q.title)}</b><div class="muted">${esc(q.detail)}</div></div></li>`).join('')}</ul>
    `, '<span class="stamp ink">OPEN</span>', 'Inquiries');

    main.innerHTML = profile + origin + physical + residences + (jobs.length ? career : '') + (partners.length ? relationships : '') + personality + interior + turning + genome + effects + inquiries;
    document.getElementById('colophon').textContent = `COMPILED BY OBSERVER (CLAUDE) FROM ${d.meta.sessions} INTERVIEW SESSIONS · NOT FOR DISTRIBUTION`;

    // Folder tabs, highlighted as each sheet scrolls into view.
    const sections = [...main.querySelectorAll('.sheet')];
    const tabs = document.getElementById('tabs');
    tabs.innerHTML = sections.map((sec, i) => `<a href="#${sec.id}"><span class="n">${i + 1}</span>${esc(sec.dataset.tab)}</a>`).join('');
    const links = [...tabs.querySelectorAll('a')];
    const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (!e.isIntersecting) continue;
            links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${e.target.id}`));
        }
    }, { rootMargin: '-30% 0px -60% 0px' });
    sections.forEach((sec) => io.observe(sec));
})();
