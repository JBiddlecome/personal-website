"""
Build assets/maps/lausd-schools.json for the /maps page.

Sources
  1. CA Dept. of Education public school directory (addresses, phone, coordinates, website).
  2. LAUSD "Maintenance and Operations Areas" map (MPD-2199, March 2010), a vector PDF whose
     colored polygons are the M&O areas N1, N2, C1, C2, C3, S1, S2.

The PDF has no geographic metadata, so it is georeferenced by matching its printed school
labels to CDE school names and fitting an affine lon/lat -> PDF-point transform with RANSAC.
Each school's coordinates are then tested against the area polygons (later-painted wins).
Schools within BORDER_PT points of an area edge are flagged `border` (about 450 m).

Usage:  python scripts/build-lausd-schools.py        (needs: pip install pymupdf numpy)
"""
import csv, json, math, os, random, re, urllib.request
import numpy as np
import pymupdf

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, '.lausd-cache')
OUT = os.path.join(HERE, '..', 'assets', 'maps', 'lausd-schools.json')
CDE_URL = 'https://www.cde.ca.gov/schooldirectory/report?rid=dl1&tp=txt'
PDF_URL = 'https://web.archive.org/web/20181023213026if_/http://mo.laschools.org/fis/existing-facilities/m-and-o/m-and-o-content/view/maps/local-districts.pdf'
BORDER_PT = 15

AREA_FILL = {  # RGB fill of each polygon in the PDF -> M&O area
    (0.75, 0.91, 1.0): 'C1', (0.75, 0.82, 1.0): 'C2', (0.45, 0.7, 1.0): 'C3',
    (0.96, 0.96, 0.49): 'N1', (1.0, 1.0, 0.75): 'N2',
    (0.96, 0.64, 0.71): 'S1',  # legend swatch says (.96,.53,.71); the map polygon is drawn in this shade
    (1.0, 0.75, 0.91): 'S2',
}
ABBR = {'ave': 'avenue', 'st': 'street', 'dr': 'drive', 'blvd': 'boulevard', 'rd': 'road', 'ln': 'lane', 'ct': 'court',
        'pl': 'place', 'hts': 'heights', 'ctr': 'center', 'elem': 'elementary', 'mag': 'magnet'}
LEVEL = {'Elementary Schools (Public)': 'Elementary', 'Intermediate/Middle Schools (Public)': 'Middle', 'High Schools (Public)': 'High',
         'K-12 Schools (Public)': 'K-12 / Span', 'Continuation High Schools': 'Alternative', 'Alternative Schools of Choice': 'Alternative',
         'District Community Day Schools': 'Alternative', 'Opportunity Schools': 'Alternative', 'Adult Education Centers': 'Adult / ROC',
         'ROC/ROP': 'Adult / ROC', 'Special Education Schools (Public)': 'Special Ed', 'Preschool': 'Preschool'}


def fetch(url, name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=120) as r, open(path, 'wb') as f:
            f.write(r.read())
    return path


def norm(s):
    return [ABBR.get(w, w) for w in re.sub(r'[^a-z0-9 ]', ' ', s.lower()).split()]


def load_schools():
    rows = csv.DictReader(open(fetch(CDE_URL, 'pubschls.txt'), encoding='utf-8'), delimiter='\t')
    return [r for r in rows if r['District'].startswith('Los Angeles Unified') and r['StatusType'] == 'Active'
            and r['School'] != 'No Data' and r['Latitude'] not in ('No Data', '')]


def fit_transform(page, schools):
    """RANSAC affine fit: [lon, lat, 1] @ T = [x, y] in PDF points."""
    index = [(norm(r['School']), r) for r in schools]
    matches = []
    for b in page.get_text('dict')['blocks']:
        for ln in b.get('lines', []):
            if not (abs(ln['dir'][1]) < 0.02 and ln['dir'][0] > 0.99):
                continue  # only horizontal text is a school label
            text = ''.join(s['text'] for s in ln['spans']).strip()
            n = norm(text)
            if len(text) < 6 or not n:
                continue
            cand = [r for nn, r in index if nn[:len(n)] == n]
            if len(cand) == 1:
                bb = ln['bbox']
                matches.append(((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, float(cand[0]['Latitude']), float(cand[0]['Longitude'])))
    A = np.array([[m[3], m[2], 1] for m in matches]); X = np.array([[m[0], m[1]] for m in matches])
    random.seed(1); best = (0, None)
    for _ in range(20000):
        idx = random.sample(range(len(matches)), 3)
        try:
            T = np.linalg.solve(A[idx], X[idx])
        except np.linalg.LinAlgError:
            continue
        inl = (np.linalg.norm(A @ T - X, axis=1) < 25).sum()
        if inl > best[0]:
            best = (inl, T)
    T = best[1]
    for thr in (25, 20):
        mask = np.linalg.norm(A @ T - X, axis=1) < thr
        T = np.linalg.lstsq(A[mask], X[mask], rcond=None)[0]
    err = np.linalg.norm(A @ T - X, axis=1)[mask]
    print(f'georeference: {mask.sum()}/{len(matches)} control points, median error {np.median(err):.1f} pt')
    return T


def bezier(p0, p1, p2, p3, n=6):
    p0, p1, p2, p3 = map(np.array, (p0, p1, p2, p3))
    return [tuple((1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3) for t in np.linspace(0, 1, n)[1:]]


def load_polygons(page):
    polys = []
    for d in page.get_drawings():
        f = d.get('fill')
        if not f or d['rect'].width < 300:  # skips legend swatches
            continue
        area = AREA_FILL.get(tuple(round(v, 2) for v in f))
        if not area:
            continue
        rings, cur = [], []
        for it in d['items']:
            if it[0] == 're':
                r = it[1]; rings.append(np.array([(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1)])); continue
            a = (it[1].x, it[1].y)
            if cur and math.dist(cur[-1], a) > 0.5:
                rings.append(np.array(cur)); cur = []
            if not cur:
                cur = [a]
            cur += [(it[2].x, it[2].y)] if it[0] == 'l' else bezier(a, (it[2].x, it[2].y), (it[3].x, it[3].y), (it[4].x, it[4].y))
        if cur:
            rings.append(np.array(cur))
        polys.append((area, rings))  # get_drawings() is in paint order
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
    page = pymupdf.open(fetch(PDF_URL, 'mo-areas.pdf'))[0]
    T = fit_transform(page, schools)
    polys = load_polygons(page)
    out = []
    for r in schools:
        lat, lng = float(r['Latitude']), float(r['Longitude'])
        area, border = classify(polys, tuple(np.array([lng, lat, 1]) @ T))
        addr = ', '.join(x for x in (r['Street'], r['City']) if x and x != 'No Data') + f", CA {r['Zip'][:5]}"
        out.append({
            'id': r['CDSCode'], 'name': r['School'], 'address': addr, 'city': r['City'], 'zip': r['Zip'][:5],
            'phone': r['Phone'] if r['Phone'] != 'No Data' else '', 'website': r['WebSite'] if r['WebSite'] != 'No Data' else '',
            'level': LEVEL.get(r['SOCType'], 'Other'), 'grades': r['GSoffered'] if r['GSoffered'] != 'No Data' else '',
            'charter': r['Charter'] == 'Y', 'region': area, 'border': bool(border), 'lat': round(lat, 6), 'lng': round(lng, 6),
        })
    out.sort(key=lambda s: (s['region'], s['name']))
    json.dump({'source': 'CA Dept. of Education directory + LAUSD M&O Areas map (2010)', 'count': len(out), 'schools': out},
              open(OUT, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)
    from collections import Counter
    print(len(out), 'schools', dict(Counter(s['region'] for s in out)), 'border-flagged', sum(s['border'] for s in out))


if __name__ == '__main__':
    main()
