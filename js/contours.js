/* ============================================================
   ShadowFinder Web – contours.js
   Turns the per-cell match-error grid into vector geometry (GeoJSON), so a band can be
   drawn on a globe and exported to GIS. Pure functions, no DOM, no map engine.
   ============================================================ */

// Grid layout shared with findShadows() in script.js: row i is latitude GRID.minLat + i*res,
// column j is longitude GRID.minLon + j*res; the value at (i, j) was sampled at exactly
// that coordinate.
const GRID = { res: 0.5, minLat: -60, maxLat: 85, minLon: -180, maxLon: 180, rows: 290, cols: 720 };

// A cell matches when its relative shadow-length error is below this.
const MATCH_TOL = 0.2;

// Version of the GeoJSON properties schema below; bump on breaking change.
const BAND_GEOJSON_VERSION = 1;

// Marching squares over `field` (Float32Array, rows*cols, row-major). A point is inside where
// value < threshold. Returns GeoJSON MultiPolygon coordinates ([] when nothing is inside),
// exterior rings counter-clockwise and holes clockwise (RFC 7946).
//
// The grid is padded with an "outside" border so every ring closes, and longitude column 0
// (-180) is repeated at +180 so a band crossing the antimeridian is cut cleanly into two
// polygons along ±180 instead of leaving a half-cell gap. Crossings onto the padding are
// pinned to the last real sample, so geometry never leaves the grid's lat/lon bounds.
function contourField(field, rows, cols, threshold, toLonLat) {
    // Corner grid: real rows/cols plus the wrapped column, plus a 1-corner pad all round.
    const R = rows + 2, C = cols + 3;
    const val = new Float64Array(R * C).fill(Infinity);
    const real = new Uint8Array(R * C);
    for (let i = 0; i < rows; i++) {
        for (let j = 0; j <= cols; j++) {
            const v = field[i * cols + (j % cols)];
            const k = (i + 1) * C + (j + 1);
            val[k] = v >= 0 ? v : Infinity;   // NaN / negative = no value
            real[k] = 1;
        }
    }
    const inside = k => val[k] < threshold;

    // Position of the threshold crossing on the corner edge p→q, in (corner-grid) x, y.
    const px = k => k % C, py = k => (k / C) | 0;
    function crossing(p, q) {
        if (!real[q]) return [px(p), py(p)];
        if (!real[p]) return [px(q), py(q)];
        const vp = val[p], vq = val[q];
        // A non-finite sample (night) has no value to interpolate toward, so the crossing goes
        // halfway, like a nearest-sample raster would draw it.
        const t = (!Number.isFinite(vp) || !Number.isFinite(vq)) ? 0.5
            : Math.min(1, Math.max(0, (threshold - vp) / (vq - vp)));
        return [px(p) + t * (px(q) - px(p)), py(p) + t * (py(q) - py(p))];
    }

    // Each edge crossing gets an id; a crossing is the start of exactly one segment and the
    // end of exactly one other (consistent orientation), so rings stitch through `next`.
    const edgeId = (p, q) => p < q ? p * 2 + (q - p === 1 ? 0 : 1) : q * 2 + (p - q === 1 ? 0 : 1);
    const next = new Map();   // start edge id -> end edge id
    const pos  = new Map();   // edge id -> [x, y]

    for (let y = 0; y < R - 1; y++) {
        for (let x = 0; x < C - 1; x++) {
            // Cell corners counter-clockwise (x east, y north): SW, SE, NE, NW.
            const a = y * C + x, b = a + 1, c = a + C + 1, d = a + C;
            const corners = [a, b, c, d];
            const ins = corners.map(inside);
            if (ins[0] === ins[1] && ins[1] === ins[2] && ins[2] === ins[3]) continue;

            // Walk the cell's edges CCW. Each inside→outside crossing starts a segment that ends
            // at the next outside→inside crossing, which keeps the inside on the segment's left.
            // At a saddle this joins the two inside corners through the cell centre.
            const exits = [], entries = [];
            for (let e = 0; e < 4; e++) {
                const p = corners[e], q = corners[(e + 1) % 4];
                if (ins[e] && !ins[(e + 1) % 4]) exits.push(e);
                else if (!ins[e] && ins[(e + 1) % 4]) entries.push(e);
            }
            for (const e of exits) {
                let f = (e + 1) % 4;
                while (!entries.includes(f)) f = (f + 1) % 4;
                const s0 = corners[e], s1 = corners[(e + 1) % 4];
                const t0 = corners[f], t1 = corners[(f + 1) % 4];
                const sid = edgeId(s0, s1), tid = edgeId(t0, t1);
                if (!pos.has(sid)) pos.set(sid, crossing(s0, s1));
                if (!pos.has(tid)) pos.set(tid, crossing(t0, t1));
                next.set(sid, tid);
            }
        }
    }

    // Stitch segments into closed rings, in lon/lat.
    const rings = [];
    for (const start of next.keys()) {
        if (!next.has(start)) continue;   // already consumed
        const ring = [];
        let id = start;
        while (next.has(id)) {
            const [x, y] = pos.get(id);
            const ll = toLonLat(x - 1, y - 1);   // undo the pad offset
            const last = ring[ring.length - 1];
            if (!last || last[0] !== ll[0] || last[1] !== ll[1]) ring.push(ll);
            const n = next.get(id);
            next.delete(id);
            id = n;
        }
        if (ring.length < 3) continue;
        ring.push(ring[0].slice());
        rings.push(ring);
    }

    return assembleMultiPolygon(rings);
}

function ringArea(ring) {
    let a = 0;
    for (let k = 0; k < ring.length - 1; k++) a += ring[k][0] * ring[k + 1][1] - ring[k + 1][0] * ring[k][1];
    return a / 2;
}

function pointInRing(pt, ring) {
    const [x, y] = pt;
    let inside = false;
    for (let k = 0, l = ring.length - 1; k < ring.length; l = k++) {
        const [xk, yk] = ring[k], [xl, yl] = ring[l];
        if ((yk > y) !== (yl > y) && x < (xl - xk) * (y - yk) / (yl - yk) + xk) inside = !inside;
    }
    return inside;
}

// Positive-area rings are exteriors, negative-area rings are holes; each hole goes into the
// smallest exterior that contains it.
function assembleMultiPolygon(rings) {
    const polys = [], holes = [];
    for (const r of rings) {
        const a = ringArea(r);
        if (a > 0) polys.push({ area: a, rings: [r] });
        else if (a < 0) holes.push(r);
    }
    for (const h of holes) {
        let best = null;
        for (const p of polys) {
            if ((!best || p.area < best.area) && pointInRing(h[0], p.rings[0])) best = p;
        }
        if (best) best.rings.push(h);
    }
    return polys.map(p => p.rings);
}

// Corner-grid (x, y) -> [lon, lat] for the GRID layout, rounded to ~1 m. The +180 wrap
// column lands exactly on 180.
function gridToLonLat(x, y) {
    const r = v => Math.round(v * 1e5) / 1e5;
    return [r(GRID.minLon + x * GRID.res), r(GRID.minLat + y * GRID.res)];
}

// MultiPolygon geometry of the cells in `field` below `threshold` (default: the match band).
function bandGeometry(field, threshold = MATCH_TOL) {
    return { type: 'MultiPolygon', coordinates: contourField(field, GRID.rows, GRID.cols, threshold, gridToLonLat) };
}

function isoUtc(ms) { return new Date(ms).toISOString().replace('.000Z', 'Z'); }

// One GeoJSON Feature for an observation { label, baseEpochMs, mode, h, s, grid }.
// In local mode baseEpochMs holds the photo's wall-clock digits (not a UTC instant), so the
// time is written without a zone and time_basis says how to read it.
function observationFeature(obs) {
    const t = isoUtc(obs.baseEpochMs);
    return {
        type: 'Feature',
        properties: {
            kind: 'observation',
            label: obs.label,
            time: obs.mode === 'local' ? t.replace('Z', '') : t,
            time_basis: obs.mode === 'local' ? 'local' : 'utc',
            object_height: obs.h,
            shadow_length: obs.s,
            height_length_ratio: obs.h / obs.s,
            sun_altitude_deg: Math.atan2(obs.h, obs.s) * 180 / Math.PI,
            tolerance: MATCH_TOL,
            grid_resolution_deg: GRID.res,
            sf_geojson_version: BAND_GEOJSON_VERSION,
        },
        geometry: bandGeometry(obs.grid),
    };
}

// The region inside every observation's band: max error across observations below the
// tolerance. Null with fewer than two observations, or when the bands do not overlap.
function intersectionFeature(observations) {
    if (observations.length < 2) return null;
    const N = observations[0].grid.length;
    const worst = new Float32Array(N);
    for (let idx = 0; idx < N; idx++) {
        let m = 0;
        for (const o of observations) if (o.grid[idx] > m) m = o.grid[idx];
        worst[idx] = m;
    }
    const geometry = bandGeometry(worst);
    if (!geometry.coordinates.length) return null;
    return {
        type: 'Feature',
        properties: {
            kind: 'intersection',
            observations: observations.map(o => o.label),
            tolerance: MATCH_TOL,
            grid_resolution_deg: GRID.res,
            sf_geojson_version: BAND_GEOJSON_VERSION,
        },
        geometry,
    };
}

// Every observation band, plus the intersection when there is one.
function bandsFeatureCollection(observations) {
    const features = observations.map(observationFeature);
    const inter = intersectionFeature(observations);
    if (inter) features.push(inter);
    return { type: 'FeatureCollection', features };
}
