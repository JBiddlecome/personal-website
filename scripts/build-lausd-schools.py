"""
Build assets/maps/lausd-schools.json for the /maps page.

Sources
  1. CA Dept. of Education public school directory (addresses, phone, coordinates, website).
  2. LAUSD Facilities Services Division, "Maintenance & Operations Areas" index map
     (Master Planning & Demographics, ArcGIS Pro export dated 2026-04-07, SY 2025-26 school layer),
     linked from https://facilities.lausd.org/apps/pages/mo-regions as "M&O_Areas_IndexMap.pdf".
     Its colored polygons (layer "M_O_Areas") are the M&O areas N1, N2, C1, C2, C3, S1, S2.
  3. (fallback / comparison only) the older March 2010 M&O Areas map, MPD-2199.

The PDF has no geographic metadata, so it is georeferenced in two steps:
  a) printed school labels are matched to CDE school names and an affine lon/lat -> PDF-point
     transform is fitted with RANSAC (labels sit a few points off their symbols);
  b) the fit is refined ICP-style against the school point symbols themselves (ESRI marker glyphs),
     ending with a 2nd-order polynomial; median residual is about 3 pt (~90 m).
Each school's projected point is then tested against the area polygons (later-painted wins).
Schools within BORDER_PT points of an area edge are flagged `border` (about 450 m).

Usage:  python scripts/build-lausd-schools.py        (needs: pip install pymupdf numpy)
If the PDF download is blocked, save the map from the M&O Regions page into
scripts/.lausd-cache/mo-areas-2026.pdf and re-run.
"""
import csv, json, math, os, random, re, urllib.request
from collections import Counter
import numpy as np
import pymupdf

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, '.lausd-cache')
OUT = os.path.join(HERE, '..', 'assets', 'maps', 'lausd-schools.json')
CDE_URL = 'https://www.cde.ca.gov/schooldirectory/report?rid=dl1&tp=txt'
MAP_PAGE = 'https://facilities.lausd.org/apps/pages/mo-regions'
PDF_URL = 'https://media.edlio.net/4accee75/fdd0cea4/f58c5047/5e672ef3710e4289b78205fde15b4649?_=M%26O_Areas_IndexMap.pdf'
BORDER_PT = 15

AREA_FILL = {  # RGB fill (0-255) of each polygon in the 2026 PDF -> M&O area
    (190, 232, 255): 'C1', (190, 210, 255): 'C2', (115, 178, 255): 'C3',
    (245, 245, 127): 'N1', (255, 255, 190): 'N2',
    (245, 163, 182): 'S1', (255, 227, 232): 'S2',
}
SYMBOL_FONTS = {'ESRIGeometricSymbols', 'ESRIDefaultMarker', 'ESRITransportationCivic', 'ESRIWeather', 'ESRICartography'}
MAP_RIGHT_EDGE = 1785  # x beyond this is the printed school index, not the map
ABBR = {'ave': 'avenue', 'st': 'street', 'dr': 'drive', 'blvd': 'boulevard', 'bl': 'boulevard', 'rd': 'road', 'ln': 'lane',
        'ct': 'court', 'pl': 'place', 'hts': 'heights', 'ctr': 'center', 'elem': 'elementary', 'es': 'elementary',
        'mag': 'magnet', 'chrtr': 'charter', 'acad': 'academy', 'lrng': 'learning', 'comm': 'community', 'pc': 'primary',
        'eec': 'early', 'inst': 'institute', 'app': 'applied', 'med': 'medical', 'sci': 'science', 'tech': 'technology',
        'ed': 'education', 'cmplx': 'complex', 'prep': 'preparatory', 'intl': 'international', 'sr': 'senior',
        'jr': 'junior', 'mt': 'mount', 'ft': 'fort', 'dl': 'dual', 'opp': 'opportunity', 'occup': 'occupational'}
SKIP = {'span', 'school', 'the', 'of', 'for', 'at'}
LEVEL = {'Elementary Schools (Public)': 'Elementary', 'Intermediate/Middle Schools (Public)': 'Middle', 'High Schools (Public)': 'High',
         'K-12 Schools (Public)': 'K-12 / Span', 'Continuation High Schools': 'Alternative', 'Alternative Schools of Choice': 'Alternative',
         'District Community Day Schools': 'Alternative', 'Opportunity Schools': 'Alternative', 'Adult Education Centers': 'Adult / ROC',
         'ROC/ROP': 'Adult / ROC', 'Special Education Schools (Public)': 'Special Ed', 'Preschool': 'Preschool'}


def fetch(url, name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Referer': MAP_PAGE})
        with urllib.request.urlopen(req, timeout=120) as r, open(path, 'wb') as f:
            f.write(r.read())
    return path


def norm(s):
    return [ABBR.get(w, w) for w in re.sub(r'[^a-z0-9 ]', ' ', s.lower()).split()]


def load_schools():
    rows = csv.DictReader(open(fetch(CDE_URL, 'pubschls.txt'), encoding='utf-8'), delimiter='\t')
    return [r for r in rows if r['District'].startswith('Los Angeles Unified') and r['StatusType'] == 'Active'
            and r['School'] != 'No Data' and r['Latitude'] not in ('No Data', '')]


def page_spans(page):
    for b in page.get_text('dict')['blocks']:
        for ln in b.get('lines', []):
            if not (abs(ln['dir'][1]) < 0.02 and ln['dir'][0] > 0.99):
                continue  # horizontal text only
            for s in ln['spans']:
                if s['bbox'][0] < MAP_RIGHT_EDGE and s['text'].strip():
                    yield s


def label_blocks(page):
    """School labels are 6.5 pt Arial, often wrapped over 2-3 centered lines: stitch them back together."""
    lab = [(s['text'].strip(), s['bbox']) for s in page_spans(page) if s['font'] == 'ArialMT' and abs(s['size'] - 6.5) < 0.05]
    lab.sort(key=lambda t: t[1][1]); used = [False] * len(lab); blocks = []
    for i in range(len(lab)):
        if used[i]:
            continue
        used[i] = True; cur = [lab[i]]
        while True:
            bb = cur[-1][1]; cx = (bb[0] + bb[2]) / 2
            nxt = next((j for j, (t, b2) in enumerate(lab) if not used[j] and 4.5 < b2[1] - bb[1] < 7.5 and abs((b2[0] + b2[2]) / 2 - cx) < 12), None)
            if nxt is None:
                break
            used[nxt] = True; cur.append(lab[nxt])
        xs = [c[1][0] for c in cur] + [c[1][2] for c in cur]; ys = [c[1][1] for c in cur] + [c[1][3] for c in cur]
        blocks.append((' '.join(c[0] for c in cur), (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2))
    return blocks


def match_label(text, index):
    n = [w for w in norm(text) if w not in SKIP]
    if not n:
        return []
    out = []
    for nn, r in index:  # every label word must prefix a later word of the CDE name, in order
        j, ok = 0, True
        for w in n:
            while j < len(nn) and not nn[j].startswith(w):
                j += 1
            if j == len(nn):
                ok = False; break
            j += 1
        if ok and (nn[0].startswith(n[0]) or len(n) >= 2):
            out.append(r)
    return out


def feats(L, deg):
    x, y = L[:, 0] + 118.35, L[:, 1] - 34.05
    f = [x, y, np.ones_like(x)] + ([x * x, x * y, y * y] if deg == 2 else [])
    return np.stack(f, 1)


def nearest(P, S):
    d = np.linalg.norm(P[:, None, :] - S[None, :, :], axis=2)
    i = d.argmin(1)
    return d[np.arange(len(P)), i], i


def georeference(page, schools):
    index = [(norm(r['School']), r) for r in schools]
    ctrl = []
    for text, x, y in label_blocks(page):
        c = match_label(text, index)
        if len(c) == 1:
            ctrl.append((x, y, float(c[0]['Longitude']), float(c[0]['Latitude'])))
    A = np.array([[m[2], m[3], 1] for m in ctrl]); X = np.array([[m[0], m[1]] for m in ctrl])
    random.seed(1); best = (0, None)
    for _ in range(20000):
        idx = random.sample(range(len(ctrl)), 3)
        try:
            T = np.linalg.solve(A[idx], X[idx])
        except np.linalg.LinAlgError:
            continue
        inl = (np.linalg.norm(A @ T - X, axis=1) < 25).sum()
        if inl > best[0]:
            best = (inl, T)
    T = best[1]
    for thr in (25, 20, 15):
        mask = np.linalg.norm(A @ T - X, axis=1) < thr
        T = np.linalg.lstsq(A[mask], X[mask], rcond=None)[0]
    print(f'label fit: {mask.sum()}/{len(ctrl)} label control points')
    # ICP refinement against the point symbols
    S = np.array([((s['bbox'][0] + s['bbox'][2]) / 2, (s['bbox'][1] + s['bbox'][3]) / 2) for s in page_spans(page)
                  if s['font'] in SYMBOL_FONTS and s['size'] < 9])
    L = np.array([[float(r['Longitude']), float(r['Latitude']), 1] for r in schools])
    P = L @ T
    for deg, thr in ((1, 15), (1, 8), (2, 6)):
        for _ in range(4):
            d, i = nearest(P, S); m = d < thr
            C = np.linalg.lstsq(feats(L, deg)[m], S[i[m]], rcond=None)[0]
            P = feats(L, deg) @ C
    d, _ = nearest(P, S)
    print(f'symbol fit: {len(S)} symbols, {(d < 6).sum()} schools within 6 pt, median {np.median(d[d < 6]):.1f} pt')
    return P


def bezier(p0, p1, p2, p3, n=6):
    p0, p1, p2, p3 = map(np.array, (p0, p1, p2, p3))
    return [tuple((1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3) for t in np.linspace(0, 1, n)[1:]]


def load_polygons(page):
    polys = []
    for d in page.get_drawings():
        f = d.get('fill')
        if not f or d['rect'].width < 50:  # skips legend swatches
            continue
        area = AREA_FILL.get(tuple(round(v * 255) for v in f))
        if not area:
            continue
        rings, cur = [], []
        for it in d['items']:
            if it[0] == 're':
                r = it[1]; rings.append(np.array([(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1)])); continue
            if it[0] == 'qu':
                q = it[1]; rings.append(np.array([(q.ul.x, q.ul.y), (q.ur.x, q.ur.y), (q.lr.x, q.lr.y), (q.ll.x, q.ll.y)])); continue
            a = (it[1].x, it[1].y)
            if cur and math.dist(cur[-1], a) > 0.5:
                rings.append(np.array(cur)); cur = []
            if not cur:
                cur = [a]
            cur += [(it[2].x, it[2].y)] if it[0] == 'l' else bezier(a, (it[2].x, it[2].y), (it[3].x, it[3].y), (it[4].x, it[4].y))
        if cur:
            rings.append(np.array(cur))
        polys.append((area, [r for r in rings if len(r) > 2]))  # get_drawings() is in paint order
    found = {a for a, _ in polys}
    assert found == set(AREA_FILL.values()), f'missing area polygons: {set(AREA_FILL.values()) - found}'
    return polys


def in_ring(pt, ring):
    x, y = pt; xs, ys = ring[:, 0], ring[:, 1]; xj, yj = np.roll(xs, 1), np.roll(ys, 1)
    return (((ys > y) != (yj > y)) & (x < (xj - xs) * (y - ys) / (yj - ys + 1e-12) + xs)).sum() % 2 == 1


def edge_dist(rings, pt):
    P = np.array(pt); best = 1e9
    for r in rings:
        b = np.roll(r, -1, axis=0); ab = b - r
        t = np.clip(((P - r) * ab).sum(1) / ((ab ** 2).sum(1) + 1e-12), 0, 1)
        best = min(best, np.linalg.norm(r + ab * t[:, None] - P, axis=1).min())
    return best


def classify(polys, pt):
    hit = None
    for area, rings in polys:  # later-painted polygon wins where they overlap
        if sum(in_ring(pt, r) for r in rings) % 2 == 1:
            hit = (area, rings)
    if hit:
        return hit[0], edge_dist(hit[1], pt) < BORDER_PT
    return min(((edge_dist(rings, pt), area) for area, rings in polys))[1], True  # outside every polygon: nearest area, flagged


def main():
    schools = load_schools()
    page = pymupdf.open(fetch(PDF_URL, 'mo-areas-2026.pdf'))[0]
    P = georeference(page, schools)
    polys = load_polygons(page)
    out = []
    for r, pt in zip(schools, P):
        lat, lng = float(r['Latitude']), float(r['Longitude'])
        area, border = classify(polys, tuple(pt))
        addr = ', '.join(x for x in (r['Street'], r['City']) if x and x != 'No Data') + f", CA {r['Zip'][:5]}"
        out.append({
            'id': r['CDSCode'], 'name': r['School'], 'address': addr, 'city': r['City'], 'zip': r['Zip'][:5],
            'phone': r['Phone'] if r['Phone'] != 'No Data' else '', 'website': r['WebSite'] if r['WebSite'] != 'No Data' else '',
            'level': LEVEL.get(r['SOCType'], 'Other'), 'grades': r['GSoffered'] if r['GSoffered'] != 'No Data' else '',
            'charter': r['Charter'] == 'Y', 'region': area, 'border': bool(border), 'lat': round(lat, 6), 'lng': round(lng, 6),
        })
    out.sort(key=lambda s: (s['region'], s['name']))
    json.dump({'source': 'CA Dept. of Education directory + LAUSD Facilities M&O Areas index map (Apr 2026, SY 2025-26)',
               'sourceUrl': MAP_PAGE, 'count': len(out), 'schools': out},
              open(OUT, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)
    print(len(out), 'schools', dict(Counter(s['region'] for s in out)), 'border-flagged', sum(s['border'] for s in out))


if __name__ == '__main__':
    main()
