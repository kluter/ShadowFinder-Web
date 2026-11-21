/* ============================================================
   ShadowFinder Web – script.js
   ============================================================ */

const $ = id => document.getElementById(id);
const canvas    = $('image-canvas');
const ctx       = canvas.getContext('2d');
const container = $('image-container');
const overlay   = $('drop-overlay');

// ---- TOAST ----

const toastCounts = new Map();
const TOAST_DURATION = 7000;
const TOAST_MAX_STACK = 3;

function showToast(msg, type = 'error') {
    const count = toastCounts.get(msg) || 0;
    if (count >= TOAST_MAX_STACK) return;
    toastCounts.set(msg, count + 1);
    const tc = $('toast-container');
    const item = document.createElement('div');
    item.className = 'toast-item' + (type === 'success' ? ' toast-success' : '');
    item.innerHTML = `<span>${msg}</span><button class="toast-close">×</button>`;
    item.querySelector('.toast-close').onclick = () => dismissToast(item, msg);
    tc.appendChild(item);
    requestAnimationFrame(() => item.classList.add('toast-visible'));
    setTimeout(() => dismissToast(item, msg), TOAST_DURATION);
}

function dismissToast(item, msg) {
    if (!item.isConnected) return;
    item.classList.add('toast-hiding');
    item.addEventListener('transitionend', () => {
        item.remove();
        const n = toastCounts.get(msg) || 1;
        if (n <= 1) toastCounts.delete(msg); else toastCounts.set(msg, n - 1);
    }, { once: true });
}

// A single, replaceable toast that lingers until dismissed (used for the angle warning)
let stickyToast = null;
function setStickyToast(msg, type) {
    if (stickyToast) { stickyToast.remove(); stickyToast = null; }
    if (!msg) return;
    const tc = $('toast-container');
    const item = document.createElement('div');
    item.className = 'toast-item' + (type === 'warn' ? ' toast-warn' : '');
    item.innerHTML = `<span>${msg}</span><button class="toast-close">×</button>`;
    item.querySelector('.toast-close').onclick = () => {
        item.remove();
        if (stickyToast === item) stickyToast = null;
    };
    tc.appendChild(item);
    requestAnimationFrame(() => item.classList.add('toast-visible'));
    stickyToast = item;
}

// ---- CONSTANTS ----

const POINT_LABELS = ['Base', 'Top', 'Shadow tip'];
const POINT_HINTS  = ['Click the base of the object', 'Click the top of the object', 'Click the tip of the shadow'];
const POINT_COLORS = ['#ffb300', '#00aaff', '#ff4d6d'];

// Two observations give a fix with a two-point ambiguity; a third resolves it. Beyond three,
// extra bands can only shrink the overlap and risk excluding the true spot, so it is capped.
const MAX_OBS = 3;

// ---- MAP ----

// MapLibre GL (bundled in vendor/, exposed by js/maplibre-global.js). Globe or flat
// (Web Mercator), switched in the map bar and remembered.
const PROJECTIONS = ['globe', 'mercator'];
let projection = PROJECTIONS.includes(localStorage.getItem('sf-projection')) ? localStorage.getItem('sf-projection') : 'globe';

const map = new maplibregl.Map({
    container: 'map-container',
    style: {
        version: 8,
        projection: { type: projection },
        sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#111' } }],
    },
    center: [0, 20],
    zoom: 1.4,
    attributionControl: { compact: true },
});
// Resolves once the style is ready for sources and layers to be added.
const mapReady = new Promise(resolve => map.once('load', resolve));
// A narrow camera lens. MapLibre's default (≈37°) is a close-up perspective that shows only
// about 80° around the centre of the globe, so a sun-ring (radius 90° minus the sun's altitude)
// ends up squeezed against the edge. At 10° the view is nearly orthographic: almost the whole
// hemisphere is visible and the ring keeps its shape.
const CAMERA_FOV = 10;
map.setVerticalFieldOfView(CAMERA_FOV);

// Compass only (zoom is scroll / pinch). With visualizePitch, clicking it resets both
// bearing and tilt, and the needle shows the tilt.
map.addControl(new maplibregl.NavigationControl({ showZoom: false, showCompass: true, visualizePitch: true }), 'top-right');

// The zoom at which the whole globe fits the map panel, with ~100 px to spare top and bottom.
// The globe's radius is 512·2^z / 2π px; seen from the camera (cam px in front of it) its edge
// appears at cam·tan(asin(R / (cam + R))).
function globeFitZoom() {
    const H = map.getContainer().clientHeight, W = map.getContainer().clientWidth;
    const target = Math.max(80, Math.min(H - 200, W - 60) / 2);
    const cam = 0.5 * H / Math.tan(CAMERA_FOV / 2 * Math.PI / 180);
    const t = target / cam, k = t / Math.sqrt(1 + t * t);
    const R = k * cam / (1 - k);
    return Math.log2(2 * Math.PI * R / 512);
}
const frameZoom = () => projection === 'globe' ? globeFitZoom() : 1.2;

async function setProjection(type) {
    projection = PROJECTIONS.includes(type) ? type : 'globe';
    localStorage.setItem('sf-projection', projection);
    syncProjectionToggle();
    $('map-container').classList.toggle('space', projection === 'globe');
    await mapReady;
    map.setProjection({ type: projection });
    // Switching to the globe shows it whole, upright, around the current longitude.
    if (projection === 'globe') map.easeTo({ center: [map.getCenter().lng, Math.max(-30, Math.min(30, map.getCenter().lat))], zoom: globeFitZoom(), bearing: 0, pitch: 0 });
}
$('map-container').classList.toggle('space', projection === 'globe');
mapReady.then(() => { if (projection === 'globe') map.jumpTo({ zoom: globeFitZoom() }); });

// A starfield tile for the space behind the globe: seeded, so it is the same on every load.
(() => {
    const S = 600, c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    let seed = 20240414;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 260; i++) {
        const x = rnd() * S, y = rnd() * S, big = rnd() < 0.06;
        const r = big ? 0.9 + rnd() * 0.6 : 0.35 + rnd() * 0.45;
        const a = big ? 0.7 + rnd() * 0.3 : 0.25 + rnd() * 0.45;
        const tint = rnd();
        g.fillStyle = tint < 0.12 ? `rgba(255,220,170,${a})` : tint < 0.24 ? `rgba(180,200,255,${a})` : `rgba(255,255,255,${a})`;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    $('map-container').style.setProperty('--stars', `url(${c.toDataURL()})`);
})();

// Compass: north up and no tilt; on the globe it also brings the equator back to the centre.
mapReady.then(() => {
    const btn = map.getContainer().querySelector('.maplibregl-ctrl-compass');
    btn?.addEventListener('click', e => {
        e.stopImmediatePropagation();
        e.preventDefault();
        const c = map.getCenter();
        map.easeTo({ bearing: 0, pitch: 0, center: projection === 'globe' ? [c.lng, 0] : c });
    }, true);
});
function syncProjectionToggle() {
    document.querySelectorAll('#projection-toggle .toggle-btn').forEach(b =>
        b.classList.toggle('active-toggle', b.dataset.projection === projection));
}
document.querySelectorAll('#projection-toggle .toggle-btn').forEach(b =>
    b.addEventListener('click', () => setProjection(b.dataset.projection)));
syncProjectionToggle();


const TILE_SETS = [
    {
        id: 'dark',
        label: 'Esri Dark Gray Canvas',
        layers: [
            { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', attribution: 'Tiles © Esri', maxzoom: 16 },
            { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', maxzoom: 16 }
        ]
    },
    {
        id: 'osm',
        label: 'OpenStreetMap',
        layers: [{ url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors', maxzoom: 19 }]
    },
    {
        id: 'esri-sat',
        label: 'Esri World Imagery',
        layers: [
            { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attribution: 'Tiles © Esri', maxzoom: 19 },
            { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', opacity: 0.7, maxzoom: 19 }
        ]
    }
];

let activeBaseIds = [];
async function setTileSet(id) {
    const set = TILE_SETS.find(s => s.id === id) || TILE_SETS[0];
    localStorage.setItem('sf-tileset', set.id);
    $('basemap-name').textContent = set.label;
    document.querySelectorAll('#basemap-menu .layer-item').forEach(i =>
        i.classList.toggle('active', i.dataset.id === set.id));

    await mapReady;
    activeBaseIds.forEach(lid => { map.removeLayer(lid); map.removeSource(lid); });
    activeBaseIds = [];
    // Basemap layers go under the daylight and band layers when they exist.
    const beforeId = [DAY_LAYER, BAND_LAYER].find(l => map.getLayer(l));
    set.layers.forEach((l, i) => {
        const lid = `base-${set.id}-${i}`;
        map.addSource(lid, { type: 'raster', tiles: [l.url], tileSize: 256, maxzoom: l.maxzoom, attribution: l.attribution || '' });
        map.addLayer({ id: lid, type: 'raster', source: lid, paint: { 'raster-opacity': l.opacity ?? 1 } }, beforeId);
        activeBaseIds.push(lid);
    });
}

// Base map dropdown: the map panel's title is the selector (as in TracePoint).
(() => {
    const btn  = $('btn-basemap');
    const menu = $('basemap-menu');
    const open = show => {
        menu.style.display = show ? 'block' : 'none';
        btn.setAttribute('aria-expanded', String(show));
    };
    TILE_SETS.forEach(set => {
        const item = document.createElement('div');
        item.className = 'layer-item';
        item.textContent = set.label;
        item.dataset.id = set.id;
        item.onclick = () => { setTileSet(set.id); open(false); };
        menu.appendChild(item);
    });
    btn.addEventListener('click', e => { e.stopPropagation(); open(menu.style.display === 'none'); });
    document.addEventListener('click', e => { if (!$('basemap-wrap').contains(e.target)) open(false); });
    map.on('mousedown', () => open(false));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') open(false); });
})();
setTileSet(localStorage.getItem('sf-tileset') || 'dark');

// ---- OBSERVATIONS (one per tab) ----
//
// Every tab is one observation: a photo with three marked points, or just a typed height and
// shadow length, plus the capture time. A tab's band is recalculated whenever its input is
// complete; `observations` is the list of bands currently on the map.

let tabSeq = 0;
function newTab() {
    return {
        id: ++tabSeq,
        img: null,          // HTMLImageElement of the photo, if any
        fileName: '',
        exif: null,
        exifDt: null,       // the capture time as EXIF gave it ({ dt, mode }), to tell an edited time
        points: [],         // up to 3: [{x,y}] in image pixels
        h: '', l: '',       // typed height / shadow length (used when there are no 3 points)
        dt: { y: '', mo: '', d: '', h: '', mi: '', s: '' },
        mode: 'utc',        // 'utc' | 'local'
        result: null,       // { id, label, baseEpochMs, mode, h, s, grid } once calculated
        noMatch: false,
        busy: false,
        framed: false,      // the map has already been turned to this tab's band once
        view: null,         // saved photo zoom/pan
        timer: 0, token: 0,
    };
}

let tabs = [newTab()];
let active = tabs[0];
let observations = [];
let resultOpacity = 0.85;
let exifGpsMarker = null;
// Bands on the map: 'all' (their overlap is the location) or 'one' (only the selected shadow's)
let showMode = 'all';

function syncObservations() {
    observations = tabs.filter(t => t.result).map(t => t.result);
}

// The bands drawn on the map, following the This / All toggle
function visibleObservations() {
    return showMode === 'one' ? (active.result ? [active.result] : []) : observations;
}

function tabIndex(t) { return tabs.indexOf(t) + 1; }

function renderTabs() {
    const wrap = $('obs-tabs');
    wrap.innerHTML = '';
    tabs.forEach(t => {
        const el = document.createElement('div');
        el.className = 'obs-tab' + (t === active ? ' active' : '');
        el.setAttribute('role', 'tab');
        el.setAttribute('aria-selected', String(t === active));
        el.title = t.result ? `${t.result.label}${t.fileName ? ' · ' + t.fileName : ''}`
                 : t.noMatch ? 'No place matches these inputs'
                 : 'Not complete yet';
        const state = t.busy ? 'busy' : t.result ? 'band' : t.noMatch ? 'nomatch' : '';
        el.innerHTML =
            `<span class="obs-dot ${state}"></span>` +
            `<span class="obs-name">Shadow ${tabIndex(t)}</span>` +
            `<button class="obs-tab-close" title="Remove this shadow" aria-label="Remove shadow ${tabIndex(t)}">×</button>`;
        el.addEventListener('click', () => switchTab(t));
        el.querySelector('.obs-tab-close').addEventListener('click', e => { e.stopPropagation(); removeTab(t); });
        wrap.appendChild(el);
    });
    const add = document.createElement('button');
    add.className = 'obs-tab-add';
    add.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
    add.setAttribute('aria-label', 'New shadow');
    add.title = tabs.length >= MAX_OBS
        ? 'Three shadows is the most that helps'
        : 'New shadow: the same place at another time';
    add.disabled = tabs.length >= MAX_OBS;
    add.addEventListener('click', addTab);
    wrap.appendChild(add);
}

function addTab() {
    if (tabs.length >= MAX_OBS) return;
    const t = newTab();
    tabs.push(t);
    switchTab(t);
}

function removeTab(t) {
    clearTimeout(t.timer);
    t.token++;   // drop any calculation still running for it
    if (tabs.length === 1) {
        // closing the last shadow is the clear-all: start fresh
        tabs = [newTab()];
        active = tabs[0];
        if (exifGpsMarker) { exifGpsMarker.remove(); exifGpsMarker = null; }
    } else {
        const i = tabs.indexOf(t);
        tabs.splice(i, 1);
        if (active === t) active = tabs[Math.max(0, i - 1)];
    }
    syncObservations();
    renderBands();
    loadTabIntoUI();
}

function switchTab(t) {
    if (t === active) return;
    saveView();
    active = t;
    loadTabIntoUI();
    if (showMode === 'one') renderBands();
}

// Shows the active tab on the left: photo, points, typed values, time and zone.
function loadTabIntoUI() {
    const t = active;
    img = t.img;
    points = t.points;
    if (img) {
        canvas.style.display = 'block';
        overlay.style.display = 'none';
        if (t.view) { fitCanvasToContainer(); ({ scale, offsetX, offsetY } = t.view); }
        else fitImage();
    } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.style.display = 'none';
        overlay.style.display = '';
    }
    canvas.style.cursor = idleCursor();
    drawCanvas();
    SEGS.forEach(s => { segEl[s].value = t.dt[s]; });
    syncDtValidity();
    syncModeToggle();
    $('exif-card').style.display = 'none';
    closeCalendar();
    syncExifChip();
    updateMeasureUI();
    updateGuide();
    renderTabs();
}

function saveView() {
    if (active && active.img) active.view = { scale, offsetX, offsetY };
}

// ---- PHOTO ----

let img = null;
let points = [];
let scale = 1, offsetX = 0, offsetY = 0;
let isPanning = false, panStartX = 0, panStartY = 0, panOffsetX = 0, panOffsetY = 0;
let spaceHeld = false;

// Loads a photo into a tab (the active one by default). A new photo is a new observation in
// that tab, so its points and band are dropped; its EXIF capture time is used when there is one.
// onReady(tab) runs once both the image and its EXIF are read (the demo places its points then).
function loadImage(file, tab = active, onReady = null) {
    const url = URL.createObjectURL(file);
    const image = new Image();
    const imageLoaded = new Promise((resolve, reject) => {
        image.onload = () => {
            tab.img = image;
            tab.fileName = file.name || '';
            tab.points.length = 0;
            tab.view = null;
            tab.result = null; tab.noMatch = false; tab.framed = false;
            syncObservations();
            renderBands();
            if (tab === active) loadTabIntoUI(); else renderTabs();
            resolve();
        };
        image.onerror = () => { showToast('Could not load image.'); reject(); };
    });
    image.src = url;

    tab.exif = null;
    tab.exifDt = null;
    const exifRead = exifr.parse(file, { tiff: true, exif: true, gps: true })
        .then(exif => { tab.exif = exif || null; })
        .catch(() => { tab.exif = null; });

    Promise.all([imageLoaded, exifRead]).then(() => {
        if (applyExifDateTime(tab, { quiet: !!onReady })) onInputChanged(tab);
        if (tab === active) {
            syncExifChip(); updateGuide();
            // Flow: the time comes first; without an EXIF time, the field is where to go next.
            if (dtEpoch(tab) == null) focusFirstEmptySeg();
        }
        if (onReady) onReady(tab);
    }).catch(() => {});
}

function fitCanvasToContainer() {
    canvas.width  = container.clientWidth;
    canvas.height = container.clientHeight;
}

function fitImage() {
    fitCanvasToContainer();
    const cw = canvas.width, ch = canvas.height;
    const iw = img.naturalWidth, ih = img.naturalHeight;
    scale = Math.min(cw / iw, ch / ih, 1);
    offsetX = (cw - iw * scale) / 2;
    offsetY = (ch - ih * scale) / 2;
}

function imageToCanvas(ix, iy) { return { x: offsetX + ix * scale, y: offsetY + iy * scale }; }
function canvasToImage(cx, cy) { return { x: (cx - offsetX) / scale, y: (cy - offsetY) / scale }; }

function drawCanvas() {
    if (!img) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
    drawPoints();
    if (points.length >= 2) drawLine(points[0], points[1], POINT_COLORS[0]);
    if (points.length === 3) drawLine(points[0], points[2], POINT_COLORS[2]);
}

function drawPoints() {
    points.forEach((p, i) => {
        const { x: cx, y: cy } = imageToCanvas(p.x, p.y);
        const color = POINT_COLORS[i];
        ctx.beginPath();
        ctx.arc(cx, cy, 6, 0, Math.PI * 2);
        ctx.fillStyle = color + '44';
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, 2, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.font = 'bold 11px system-ui';
        ctx.fillStyle = color;
        ctx.fillText(POINT_LABELS[i], cx + 9, cy + 4);
    });
}

function drawLine(a, b, color) {
    const A = imageToCanvas(a.x, a.y), B = imageToCanvas(b.x, b.y);
    ctx.beginPath();
    ctx.setLineDash([4, 3]);
    ctx.moveTo(A.x, A.y);
    ctx.lineTo(B.x, B.y);
    ctx.strokeStyle = color + 'aa';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
}

// Points: click to place the next one, drag any placed one (while placing and afterwards); the
// band follows as soon as the drag pauses.
const HIT_RADIUS = 11;
let dragIdx = -1, suppressClick = false;

function canvasXY(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function pointAt(cx, cy) {
    for (let i = points.length - 1; i >= 0; i--) {
        const p = imageToCanvas(points[i].x, points[i].y);
        if (Math.hypot(p.x - cx, p.y - cy) <= HIT_RADIUS) return i;
    }
    return -1;
}
function clampToImage(p) {
    return { x: Math.min(img.naturalWidth, Math.max(0, p.x)), y: Math.min(img.naturalHeight, Math.max(0, p.y)) };
}
function idleCursor(cx, cy) {
    if (!img) return 'default';
    if (cx != null && pointAt(cx, cy) >= 0) return 'grab';
    return points.length < 3 ? 'crosshair' : 'default';
}

// Left button: on a point it drags the point; elsewhere a press that moves more than a few
// pixels pans the photo, and one that doesn't is a click that places the next point.
let pendingPan = null;
canvas.addEventListener('mousedown', e => {
    if (e.button !== 0 || spaceHeld || !img) return;
    const { x, y } = canvasXY(e);
    const i = pointAt(x, y);
    if (i < 0) { pendingPan = { x: e.clientX, y: e.clientY, ox: offsetX, oy: offsetY }; return; }
    e.preventDefault();
    dragIdx = i;
    canvas.style.cursor = 'grabbing';
});
window.addEventListener('mousemove', e => {
    if (!pendingPan || isPanning) return;
    if (Math.hypot(e.clientX - pendingPan.x, e.clientY - pendingPan.y) <= 4) return;
    isPanning = true;
    panStartX = pendingPan.x; panStartY = pendingPan.y;
    panOffsetX = pendingPan.ox; panOffsetY = pendingPan.oy;
    canvas.style.cursor = 'grabbing';
});
window.addEventListener('mouseup', () => { pendingPan = null; });
canvas.addEventListener('mousemove', e => {
    if (dragIdx >= 0 || isPanning) return;
    const { x, y } = canvasXY(e);
    canvas.style.cursor = idleCursor(x, y);
});
window.addEventListener('mousemove', e => {
    if (dragIdx < 0) return;
    const { x, y } = canvasXY(e);
    points[dragIdx] = clampToImage(canvasToImage(x, y));
    drawCanvas();
    onInputChanged(active, { delay: 150, quiet: true });
});
window.addEventListener('mouseup', e => {
    if (dragIdx < 0) return;
    dragIdx = -1;
    suppressClick = true;   // the click that ends a drag places no point
    const { x, y } = canvasXY(e);
    canvas.style.cursor = idleCursor(x, y);
});

canvas.addEventListener('click', e => {
    if (suppressClick) { suppressClick = false; return; }
    if (!img || isPanning || spaceHeld || points.length >= 3) return;
    const { x, y } = canvasXY(e);
    const { x: ix, y: iy } = canvasToImage(x, y);
    if (ix < 0 || iy < 0 || ix > img.naturalWidth || iy > img.naturalHeight) return;
    points.push({ x: ix, y: iy });
    canvas.style.cursor = idleCursor(x, y);
    drawCanvas();
    onInputChanged(active);
    // Flow: three points done → straight on to the capture time if it is still missing.
    if (points.length === 3 && dtEpoch(active) == null) focusFirstEmptySeg();
});

// Pan / zoom
container.addEventListener('wheel', e => {
    if (!img) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const newScale = Math.max(0.1, Math.min(20, scale * (e.deltaY < 0 ? 1.1 : 0.9)));
    offsetX = mx - (mx - offsetX) * (newScale / scale);
    offsetY = my - (my - offsetY) * (newScale / scale);
    scale = newScale;
    drawCanvas();
}, { passive: false });

canvas.addEventListener('mousedown', e => {
    if (e.button === 1 || (e.button === 0 && spaceHeld)) {
        e.preventDefault();
        isPanning = true;
        panStartX = e.clientX; panStartY = e.clientY;
        panOffsetX = offsetX;  panOffsetY = offsetY;
        canvas.style.cursor = 'grab';
    }
});
window.addEventListener('mousemove', e => {
    if (!isPanning) return;
    offsetX = panOffsetX + (e.clientX - panStartX);
    offsetY = panOffsetY + (e.clientY - panStartY);
    drawCanvas();
});
window.addEventListener('mouseup', () => {
    if (!isPanning) return;
    // let the click that ends a pan pass without placing a point
    setTimeout(() => { isPanning = false; }, 0);
    canvas.style.cursor = idleCursor();
});

const isTyping = el => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
window.addEventListener('keydown', e => {
    if (e.code === 'Space' && !isTyping(e.target)) { spaceHeld = true; e.preventDefault(); }
});
window.addEventListener('keyup', e => { if (e.code === 'Space') spaceHeld = false; });

window.addEventListener('resize', () => {
    if (!img) return;
    fitImage();
    drawCanvas();
});

// Drop: the first photo goes into the current tab (or a new one if this tab already has a
// photo with a band), any further photos into new tabs, up to the cap.
container.addEventListener('dragover', e => { e.preventDefault(); container.classList.add('drag-active'); });
container.addEventListener('dragleave', () => container.classList.remove('drag-active'));
container.addEventListener('drop', e => {
    e.preventDefault();
    container.classList.remove('drag-active');
    const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
    if (!files.length) { showToast('Please drop an image file.'); return; }
    loadFiles(files);
});

function loadFiles(files) {
    let target = active;
    files.forEach((f, i) => {
        if (i > 0) {
            if (tabs.length >= MAX_OBS) { if (i === files.length - 1) showToast('Three observations is the most that helps; extra photos were skipped.'); return; }
            target = newTab();
            tabs.push(target);
        }
        loadImage(f, target);
    });
    renderTabs();
}

$('btn-browse').addEventListener('click', () => $('file-picker').click());
$('file-picker').addEventListener('change', e => {
    const files = [...e.target.files].filter(f => f.type.startsWith('image/'));
    if (files.length) loadFiles(files);
    e.target.value = '';
});

// Paste anywhere on the page (not while typing in a field): a photo goes into the shadow tab,
// coordinates or a map link become a pin on the map.
document.addEventListener('paste', e => {
    if (isTyping(e.target)) return;
    const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); loadFiles(files); return; }
    const text = e.clipboardData?.getData('text') || '';
    const ll = parseCoordinates(text);
    if (ll) { e.preventDefault(); pinLocation(ll); }
    else if (text.trim()) showToast('That is not an image or coordinates.');
});

// ---- MEASUREMENTS & ANGLE QUALITY ----

const parseNum = s => { const v = parseFloat(String(s).replace(',', '.')); return v > 0 ? v : null; };

// Height and shadow length of a tab: from its three points, else from the typed values.
function getMeasurements(t) {
    if (t.points.length === 3) {
        const [b, top, tip] = t.points;
        const vObj  = { x: top.x - b.x, y: top.y - b.y };
        const vShad = { x: tip.x - b.x, y: tip.y - b.y };
        const h = Math.hypot(vObj.x, vObj.y);
        const s = Math.hypot(vShad.x, vShad.y);
        if (s < 1 || h < 1) return null;
        const cross = Math.abs(vObj.x * vShad.y - vObj.y * vShad.x);
        const dot   = vObj.x * vShad.x + vObj.y * vShad.y;
        return { h, s, angleDeg: Math.atan2(cross, dot) * 180 / Math.PI, fromPoints: true };
    }
    const h = parseNum(t.h), s = parseNum(t.l);
    return h && s ? { h, s, fromPoints: false } : null;
}

// Angle quality based on the displayed (rounded) degrees. Asymmetric: the acute side (< 90°,
// shadow receding toward the horizon) is heavily foreshortened and unreliable; the obtuse side
// (> 90°, shadow toward the camera / foreground) is far more forgiving.
function angleQuality(angleDeg) {
    const r = Math.round(angleDeg);
    if (r >= 88 && r <= 98) return 'good';
    if ((r >= 85 && r <= 87) || (r >= 99 && r <= 109)) return 'borderline';
    return 'bad';
}

const ANGLE_MSG = {
    bad: a => a < 90
        ? `${a}° — the shadow runs away toward the horizon, where it gets heavily foreshortened, so it likely measures too short and the result can't be guaranteed accurate. A shadow running sideways across the frame (about 90°) is most reliable.`
        : `${a}° — the shadow runs steeply toward the camera, so its length may be distorted and the result can't be guaranteed accurate. A shadow running sideways across the frame (about 90°) is most reliable.`,
    borderline: a => a < 90
        ? `${a}° — the shadow angles somewhat toward the distance, so expect some foreshortening. Usable for a rough location.`
        : `${a}° — the shadow angles somewhat toward the camera. Usually still usable, with a little error.`,
    good: a => `${a}° — the shadow runs nicely sideways across the frame. This measurement is reliable.`,
};

function applyAngleWarning(angleDeg) {
    const a = Math.round(angleDeg);
    const q = angleQuality(angleDeg);
    if (q === 'bad')             setStickyToast(ANGLE_MSG.bad(a), 'error');
    else if (q === 'borderline') setStickyToast(ANGLE_MSG.borderline(a), 'warn');
    else                         setStickyToast(null);
}

// H / L fields: they show the measured pixels once three points are set (read-only), and are
// typed values otherwise.
const inputH = $('input-h'), inputL = $('input-l');
function updateMeasureUI() {
    const t = active;
    const field = $('hl-field');
    const angEl = $('measure-angle');
    const m = getMeasurements(t);
    $('btn-reset').disabled = !(t.points.length || t.h !== '' || t.l !== '');
    field.classList.remove('q-good', 'q-warn', 'q-bad', 'measured');
    if (m && m.fromPoints) {
        inputH.value = Math.round(m.h) + ' px';
        inputL.value = Math.round(m.s) + ' px';
        inputH.readOnly = inputL.readOnly = true;
        const q = angleQuality(m.angleDeg);
        const zone = q === 'good' ? 'good' : q === 'borderline' ? 'warn' : 'bad';
        field.classList.add('measured', 'q-' + zone);
        angEl.hidden = false;
        angEl.textContent = '∠' + Math.round(m.angleDeg) + '°';
        angEl.className = 'measure-angle zone-' + zone;
        angEl.title = q === 'good'
            ? 'Shadow is perpendicular to the object — measurement is reliable.'
            : 'Click to see why this angle matters.';
        applyAngleWarning(m.angleDeg);
    } else {
        inputH.readOnly = inputL.readOnly = false;
        if (document.activeElement !== inputH) inputH.value = t.h;
        if (document.activeElement !== inputL) inputL.value = t.l;
        angEl.hidden = true;
        setStickyToast(null);
    }
}

$('measure-angle').addEventListener('click', () => {
    const m = getMeasurements(active);
    if (!m || !m.fromPoints) return;
    if (angleQuality(m.angleDeg) === 'good') showToast(ANGLE_MSG.good(Math.round(m.angleDeg)), 'success');
    else applyAngleWarning(m.angleDeg);
});

[[inputH, 'h'], [inputL, 'l']].forEach(([el, key]) => {
    el.addEventListener('input', () => {
        if (el.readOnly) return;
        el.value = el.value.replace(/[^\d.,]/g, '');
        active[key] = el.value;
        onInputChanged(active);
    });
    // Flow: Enter moves on — height → length → capture time.
    el.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (el === inputH) inputL.focus();
        else if (dtEpoch(active) == null) focusFirstEmptySeg();
        else el.blur();
    });
});

// ---- CAPTURE DATE & TIME ----
//
// Six small fields that behave as one: digits run on into the next part, ↑/↓ change the part
// under the cursor, Backspace on an empty part steps back, and a pasted date fills them all.

const SEGS = ['y', 'mo', 'd', 'h', 'mi', 's'];
const SEG_LEN = { y: 4, mo: 2, d: 2, h: 2, mi: 2, s: 2 };
const segEl = Object.fromEntries([...document.querySelectorAll('.dt-seg')].map(el => [el.dataset.seg, el]));
const pad2 = v => String(v).padStart(2, '0');
const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

// Epoch ms of a tab's capture time (wall-clock digits as UTC), or null while incomplete/invalid.
// Seconds may be left empty (= 0).
function dtEpoch(t) {
    const v = {};
    for (const s of SEGS) {
        if (t.dt[s] === '') { if (s === 's') { v.s = 0; continue; } return null; }
        v[s] = +t.dt[s];
    }
    if (String(t.dt.y).length !== 4 || v.y < 1900 || v.y > 2100) return null;
    if (v.mo < 1 || v.mo > 12 || v.d < 1 || v.d > daysInMonth(v.y, v.mo)) return null;
    if (v.h > 23 || v.mi > 59 || v.s > 59) return null;
    return Date.UTC(v.y, v.mo - 1, v.d, v.h, v.mi, v.s);
}

function dtFilled(t) { return SEGS.every(s => s === 's' || t.dt[s] !== ''); }

function syncDtValidity() {
    $('dt-field').classList.toggle('invalid', dtFilled(active) && dtEpoch(active) == null);
    $('dt-field').classList.toggle('complete', dtEpoch(active) != null);
}

function setSeg(s, value) {
    active.dt[s] = value;
    segEl[s].value = value;
}

function focusSeg(s) { const el = segEl[s]; if (el) { el.focus(); el.select(); } }
function focusFirstEmptySeg() { focusSeg(SEGS.find(s => active.dt[s] === '') || 'y'); }
const nextSeg = s => SEGS[SEGS.indexOf(s) + 1];
const prevSeg = s => SEGS[SEGS.indexOf(s) - 1];

// A first digit that can't start a two-digit value (e.g. 4 for a month) completes the part.
const SEG_FIRST_MAX = { mo: 1, d: 3, h: 2, mi: 5, s: 5 };

function onDtChanged() {
    syncDtValidity();
    syncExifChip();
    onInputChanged(active);
}

SEGS.forEach(s => {
    const el = segEl[s];
    el.addEventListener('focus', () => el.select());
    el.addEventListener('input', () => {
        // Digits beyond this part's length run on into the next parts, so fast typing or an
        // inserted "20240621" fills year, month and day.
        let digits = el.value.replace(/\D/g, '');
        let seg = s, last = s;
        while (seg) {
            const len = SEG_LEN[seg];
            let v, take;
            if (seg !== 'y' && digits.length && +digits[0] > SEG_FIRST_MAX[seg]) { v = '0' + digits[0]; take = 1; }
            else { v = digits.slice(0, len); take = v.length; }
            digits = digits.slice(take);
            setSeg(seg, v);
            last = seg;
            if (!digits.length || v.length < len) break;
            seg = nextSeg(seg);
        }
        onDtChanged();
        if (active.dt[last].length === SEG_LEN[last]) {
            const n = nextSeg(last);
            if (n) focusSeg(n); else segEl[last].blur();
        } else if (last !== s) focusSeg(last);
    });
    el.addEventListener('blur', () => {
        if (s !== 'y' && el.value.length === 1) { setSeg(s, '0' + el.value); onDtChanged(); }
    });
    el.addEventListener('keydown', e => {
        const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
        const atEnd = el.selectionStart === el.value.length;
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            stepSeg(s, e.key === 'ArrowUp' ? 1 : -1);
        } else if (e.key === 'Backspace' && el.value === '') {
            e.preventDefault();
            const p = prevSeg(s); if (p) focusSeg(p);
        } else if (e.key === 'ArrowLeft' && atStart) {
            const p = prevSeg(s); if (p) { e.preventDefault(); focusSeg(p); }
        } else if (e.key === 'ArrowRight' && atEnd) {
            const n = nextSeg(s); if (n) { e.preventDefault(); focusSeg(n); }
        } else if (['-', ':', ' ', '/', '.', 'T', 't'].includes(e.key)) {
            // a typed separator finishes the part
            e.preventDefault();
            if (s !== 'y' && el.value.length === 1) { setSeg(s, '0' + el.value); onDtChanged(); }
            const n = nextSeg(s); if (n && el.value) focusSeg(n);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            el.blur();
            if (dtEpoch(active) == null) focusFirstEmptySeg();
        }
    });
    el.addEventListener('paste', e => {
        const text = (e.clipboardData || window.clipboardData).getData('text');
        if (applyDateText(text)) { e.preventDefault(); onDtChanged(); segEl.s.blur(); }
    });
});

// Fills the fields from a pasted date: ISO (2024-06-21T09:00:00), EXIF (2024:06:21 09:00:00)
// or with slashes / dots; a date alone fills only the date.
function applyDateText(text) {
    const m = String(text).trim().match(/^(\d{4})[-:/.](\d{1,2})[-:/.](\d{1,2})(?:[ T]+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?)?/);
    if (!m) return false;
    setSeg('y', m[1]); setSeg('mo', pad2(m[2])); setSeg('d', pad2(m[3]));
    if (m[4] != null) { setSeg('h', pad2(m[4])); setSeg('mi', m[5]); setSeg('s', m[6] ?? '00'); }
    return true;
}

function stepSeg(s, dir) {
    const now = new Date();
    const t = active;
    const cur = t.dt[s] === '' ? null : +t.dt[s];
    const y = +t.dt.y || now.getFullYear(), mo = +t.dt.mo || now.getMonth() + 1;
    const range = { y: [1900, 2100], mo: [1, 12], d: [1, daysInMonth(y, mo)], h: [0, 23], mi: [0, 59], s: [0, 59] }[s];
    const start = { y: now.getFullYear(), mo: now.getMonth() + 1, d: now.getDate(), h: 12, mi: 0, s: 0 }[s];
    let v = cur == null ? start : cur + dir;
    if (s === 'y') v = Math.min(range[1], Math.max(range[0], v));
    else if (v > range[1]) v = range[0];
    else if (v < range[0]) v = range[1];
    setSeg(s, s === 'y' ? String(v) : pad2(v));
    segEl[s].select();
    onDtChanged();
}

// Calendar: stays on the days of one month; the arrows change month («/» a year).
let calY = 0, calM = 0;   // month shown, M = 1..12
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function openCalendar() {
    const t = active, now = new Date();
    calY = (String(t.dt.y).length === 4 ? +t.dt.y : now.getFullYear());
    calM = (+t.dt.mo >= 1 && +t.dt.mo <= 12) ? +t.dt.mo : now.getMonth() + 1;
    renderCalendar();
    $('cal-pop').style.display = 'block';
}
function closeCalendar() { $('cal-pop').style.display = 'none'; }

function renderCalendar() {
    const pop = $('cal-pop');
    const first = new Date(Date.UTC(calY, calM - 1, 1)).getUTCDay();   // 0 = Sunday
    const lead = (first + 6) % 7;                                       // weeks start on Monday
    const n = daysInMonth(calY, calM);
    const sel = (+active.dt.y === calY && +active.dt.mo === calM) ? +active.dt.d : 0;
    const now = new Date();
    const today = (now.getFullYear() === calY && now.getMonth() + 1 === calM) ? now.getDate() : 0;
    let cells = '';
    for (let i = 0; i < lead; i++) cells += '<span></span>';
    for (let d = 1; d <= n; d++) {
        cells += `<button type="button" class="cal-day${d === sel ? ' selected' : ''}${d === today ? ' today' : ''}" data-day="${d}">${d}</button>`;
    }
    pop.innerHTML =
        `<div class="cal-head">` +
            `<button type="button" data-nav="-12" title="Previous year">«</button>` +
            `<button type="button" data-nav="-1" title="Previous month">‹</button>` +
            `<span class="cal-title">${MONTHS[calM - 1]} ${calY}</span>` +
            `<button type="button" data-nav="1" title="Next month">›</button>` +
            `<button type="button" data-nav="12" title="Next year">»</button>` +
        `</div>` +
        `<div class="cal-grid">` +
            ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(w => `<span class="cal-wd">${w}</span>`).join('') +
            cells +
        `</div>`;
}

$('btn-calendar').addEventListener('click', e => {
    e.stopPropagation();
    if ($('cal-pop').style.display === 'none') openCalendar(); else closeCalendar();
});
$('cal-pop').addEventListener('click', e => {
    e.stopPropagation();
    const nav = e.target.closest('[data-nav]');
    if (nav) {
        const k = calY * 12 + (calM - 1) + +nav.dataset.nav;
        calY = Math.floor(k / 12); calM = k % 12 + 1;
        renderCalendar();
        return;
    }
    const day = e.target.closest('[data-day]');
    if (day) {
        setSeg('y', String(calY)); setSeg('mo', pad2(calM)); setSeg('d', pad2(+day.dataset.day));
        closeCalendar();
        onDtChanged();
        // Flow: day picked → on to the time
        if (active.dt.h === '') focusSeg('h');
    }
});
document.addEventListener('click', e => { if (!$('dt-wrap').contains(e.target)) closeCalendar(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCalendar(); });

// UTC / Local, inside the When field
function syncModeToggle() {
    document.querySelectorAll('#tz-toggle .tz-btn').forEach(b =>
        b.classList.toggle('active-toggle', b.dataset.mode === active.mode));
}
document.querySelectorAll('#tz-toggle .tz-btn').forEach(b => b.addEventListener('click', () => {
    if (active.mode === b.dataset.mode) return;
    active.mode = b.dataset.mode;
    active.framed = false;   // a band in the other time basis is a different shape
    syncModeToggle();
    syncExifChip();
    onInputChanged(active);
}));

// ---- EXIF ----

function pick(obj, ...keys) {
    for (const k of keys) if (obj[k] != null) return obj[k];
    return null;
}

function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatExifDate(val) {
    if (!val) return null;
    if (val instanceof Date) return val.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    if (typeof val === 'string') {
        const m = val.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
        if (m) return new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6])
            .toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    }
    return String(val);
}

function dmsToDecimal(dms) {
    if (!dms || !Array.isArray(dms) || dms.length < 3) return null;
    return dms[0] + dms[1] / 60 + dms[2] / 3600;
}

function exifGps(e) {
    const lat = dmsToDecimal(e?.GPSLatitude), lng = dmsToDecimal(e?.GPSLongitude);
    if (lat == null || lng == null) return null;
    return { lat: e.GPSLatitudeRef === 'S' ? -lat : lat, lng: e.GPSLongitudeRef === 'W' ? -lng : lng };
}

// Copies the photo's EXIF capture time into a tab's date/time and zone, and remembers it so an
// edited time can be told apart and restored. Returns true when it did.
function applyExifDateTime(tab = active, { quiet = true } = {}) {
    const ext = readExifTime(tab.exif);
    if (!ext) return false;
    tab.exifDt = ext;
    tab.dt = { ...ext.dt };
    tab.mode = ext.mode;
    if (tab === active) {
        SEGS.forEach(s => { segEl[s].value = tab.dt[s]; });
        syncDtValidity();
        syncModeToggle();
        syncExifChip();
    }
    if (!quiet) showToast(`Date and time taken from the photo's EXIF (${ext.mode === 'local' ? 'local time' : 'UTC'}). Check them before relying on the result.`, 'success');
    return true;
}

// The capture time in an EXIF record, as { dt, mode }, or null.
function readExifTime(ex) {
    if (!ex) return null;
    const raw = pick(ex, 'DateTimeOriginal', 'DateTimeDigitized', 'DateTime');
    if (!raw) return null;
    let year, month, day, hour, minute, second = 0;

    if (raw instanceof Date) {
        // exifr builds the Date from the EXIF wall-clock with LOCAL constructors, so the
        // local getters read back exactly the digits stored in the file (no timezone shift).
        year = raw.getFullYear(); month = raw.getMonth() + 1; day = raw.getDate();
        hour = raw.getHours(); minute = raw.getMinutes(); second = raw.getSeconds();
    } else if (typeof raw === 'string') {
        const m = raw.match(/^(\d{4})[: -](\d{2})[: -](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
        if (!m) return null;
        year = +m[1]; month = +m[2]; day = +m[3];
        hour = +m[4]; minute = +m[5]; second = m[6] ? +m[6] : 0;
    } else return null;

    // An EXIF offset tag means the stored wall-clock is local time; with no offset we take
    // the value as already UTC (e.g. images prepared with the capture time written in UTC).
    const offsetStr = pick(ex, 'OffsetTimeOriginal', 'OffsetTime', 'OffsetTimeDigitized');
    const useLocal = typeof offsetStr === 'string' && /[+-]\d{2}:\d{2}/.test(offsetStr);
    return {
        dt: { y: String(year), mo: pad2(month), d: pad2(day), h: pad2(hour), mi: pad2(minute), s: pad2(second) },
        mode: useLocal ? 'local' : 'utc',
    };
}

function exifTimeEdited(t) {
    return !!t.exifDt && (SEGS.some(s => t.dt[s] !== t.exifDt.dt[s]) || t.mode !== t.exifDt.mode);
}

// The EXIF chip in the When field: "EXIF" while the time is the photo's own, "edited ↺" once
// changed (a click restores it). Hidden when the photo has no capture time or GPS.
function syncExifChip() {
    const t = active, chip = $('btn-exif');
    const gps = exifGps(t.exif);
    const has = !!(t.exif && (t.exifDt || gps));
    $('exif-wrap').hidden = !has;
    if (!has) { $('exif-card').style.display = 'none'; return; }
    const edited = exifTimeEdited(t);
    chip.classList.toggle('edited', edited);
    chip.textContent = edited ? 'edited ↺' : 'EXIF';
    chip.title = edited ? "You changed the photo's EXIF time. Click to restore it."
               : gps   ? "Time from the photo's EXIF. Click to show where it was taken (GPS) on the map."
               :         "Time from the photo's EXIF.";
}

function renderExifCard() {
    const card = $('exif-card');
    const e = active.exif;
    if (!e) {
        card.innerHTML = '<p class="exif-empty">No metadata found in this image.</p>';
        return;
    }
    try {
        const gps = exifGps(e);
        const date = pick(e, 'DateTimeOriginal', 'DateTimeDigitized', 'DateTime');
        const rows = [
            ['Date',       formatExifDate(date)],
            ['Camera',     [e.Make, e.Model].filter(Boolean).join(' ') || null],
            ['Lens',       e.LensModel || null],
            ['Focal len',  pick(e,'FocalLength') != null ? `${e.FocalLength} mm` : null],
            ['Aperture',   pick(e,'FNumber') != null ? `f/${e.FNumber}` : null],
            ['Shutter',    pick(e,'ExposureTime') != null ? `${e.ExposureTime < 1 ? '1/'+ Math.round(1/e.ExposureTime) : e.ExposureTime} s` : null],
            ['ISO',        pick(e,'ISO','ISOSpeedRatings')],
            ['GPS',        gps ? `${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}` : null],
        ].filter(r => r[1] != null);

        const copyIcon = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="9" height="9" rx="1"/><path d="M2 11V2h9"/></svg>`;
        const tableRows = rows.map(([k, v]) => k === 'GPS'
            ? `<tr><td>${escHtml(k)}</td><td>${escHtml(v)}<button class="exif-copy-btn" data-coords="${escHtml(v)}" title="Copy coordinates">${copyIcon}</button></td></tr>`
            : `<tr><td>${escHtml(k)}</td><td>${escHtml(v)}</td></tr>`
        ).join('');
        const crosshair = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
            <circle cx="8" cy="8" r="3"/>
            <line x1="8" y1="1" x2="8" y2="4.5"/>
            <line x1="8" y1="11.5" x2="8" y2="15"/>
            <line x1="1" y1="8" x2="4.5" y2="8"/>
            <line x1="11.5" y1="8" x2="15" y2="8"/>
        </svg>`;
        const gpsBtn = gps ? `<button class="exif-gps-btn" id="btn-exif-gps">${crosshair}Show on map</button>` : '';

        card.innerHTML =
            '<div class="exif-card-header">Photo metadata (EXIF)</div>' +
            (rows.length ? `<table class="exif-table">${tableRows}</table>` : '<p class="exif-empty">No relevant metadata found.</p>') +
            gpsBtn;

        card.querySelector('#btn-exif-gps')?.addEventListener('click', () => {
            goToExifGps(gps.lat, gps.lng);
            card.style.display = 'none';
        });
        card.querySelectorAll('.exif-copy-btn').forEach(btn => {
            btn.addEventListener('click', () => navigator.clipboard.writeText(btn.dataset.coords).catch(() => {}));
        });
    } catch {
        card.innerHTML = '<p class="exif-empty">Could not read metadata.</p>';
    }
}

function goToExifGps(lat, lng) {
    if (exifGpsMarker) { exifGpsMarker.remove(); exifGpsMarker = null; }
    const el = document.createElement('div');
    el.className = 'exif-gps-marker';
    const exifCoords = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    const popup = new maplibregl.Popup({ className: 'tp-popup tp-popup-exif', offset: 14, maxWidth: 'none' })
        .setHTML(
            `<div class="tp-popup-header">EXIF GPS Position</div>` +
            `<div class="tp-popup-body">` +
            `<span>${exifCoords}</span>` +
            `<button class="tp-copy-btn" data-action="copy-coords" data-coords="${exifCoords}" title="Copy coordinates">` +
            `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">` +
            `<rect x="5" y="5" width="9" height="9" rx="1"/><path d="M2 11V2h9"/>` +
            `</svg></button>` +
            `</div>`
        );
    exifGpsMarker = new maplibregl.Marker({ element: el })
        .setLngLat([lng, lat])
        .setPopup(popup)
        .addTo(map);
    map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 10) });
    map.once('moveend', () => { if (exifGpsMarker && !popup.isOpen()) exifGpsMarker.togglePopup(); });
}

// Delegated copy handler for popup coordinate buttons
document.addEventListener('click', e => {
    const btn = e.target.closest('[data-action="copy-coords"]');
    if (btn) navigator.clipboard.writeText(btn.dataset.coords).catch(() => {});
});

// Chip: click restores an edited EXIF time, otherwise shows the GPS position; hover shows the metadata.
$('btn-exif').addEventListener('click', e => {
    e.stopPropagation();
    const t = active;
    if (exifTimeEdited(t)) {
        if (applyExifDateTime(t)) onInputChanged(t);
        return;
    }
    const gps = exifGps(t.exif);
    if (gps) { $('exif-card').style.display = 'none'; goToExifGps(gps.lat, gps.lng); }
});
(() => {
    const wrap = $('exif-wrap'), card = $('exif-card');
    let hideTimer = 0;
    wrap.addEventListener('mouseenter', () => {
        clearTimeout(hideTimer);
        renderExifCard();
        card.style.display = 'block';
    });
    wrap.addEventListener('mouseleave', () => {
        hideTimer = setTimeout(() => { card.style.display = 'none'; }, 250);
    });
})();

// ---- RESET: the measurement (points / typed H·L) and, separately, the time ----

function resetMeasurement() {
    const t = active;
    t.points.length = 0;
    t.h = ''; t.l = '';
    t.result = null; t.noMatch = false; t.framed = false;
    clearTimeout(t.timer); t.token++;
    syncObservations();
    renderBands();
    canvas.style.cursor = idleCursor();
    drawCanvas();
    updateMeasureUI();
    updateGuide();
    renderTabs();
}
$('btn-reset').addEventListener('click', resetMeasurement);

// Clears the time (the EXIF chip, if any, then reads "edited ↺" and restores it).
function resetTime() {
    const t = active;
    SEGS.forEach(s => setSeg(s, ''));
    t.result = null; t.noMatch = false; t.framed = false;
    clearTimeout(t.timer); t.token++;
    syncObservations();
    renderBands();
    onDtChanged();
    renderTabs();
    focusSeg('y');
}
$('btn-reset-time').addEventListener('click', resetTime);
function syncResetTime() { $('btn-reset-time').disabled = !SEGS.some(s => active.dt[s] !== ''); }

// ---- DEMO ----
// A demo photo whose EXIF carries the capture time; the points are for the user to set (the
// teal box and its shadow, which runs sideways across the frame, work best).
const DEMO_FILE = 'DEMO_20240414_134449138.jpg';

function loadDemo() {
    fetch('assets/' + DEMO_FILE)
        .then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); })
        .then(blob => {
            // into this shadow if it is empty, else a new one (or this one at the cap)
            const empty = !active.img && !getMeasurements(active);
            if (!empty && tabs.length < MAX_OBS) { const t = newTab(); tabs.push(t); switchTab(t); }
            loadImage(new File([blob], DEMO_FILE, { type: 'image/jpeg' }), active, () => {
                showToast('Demo loaded, with the time from its EXIF. Mark the teal box: its base, its top, then the tip of its shadow.', 'success');
            });
        })
        .catch(() => showToast('Could not load the demo image.'));
}
$('btn-demo-link').addEventListener('click', loadDemo);
$('btn-demo').addEventListener('click', loadDemo);

// ---- STEP GUIDE ----
// The steps as icons down the right edge of the photo, the current one lit; the bottom hint
// says what to do next (as in TracePoint).

const GUIDE_STEPS = [
    { title: 'Add a photo, or type H and L',            icon: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 8"/>' },
    { title: 'Set the capture time',                    icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>' },
    { title: 'Mark base, top and tip of the shadow',    icon: '<path d="M7 3v15"/><path d="M7 18h11" stroke-dasharray="2.2 2.2"/><circle cx="7" cy="18" r="2.2" fill="currentColor"/><circle cx="7" cy="4.5" r="2.2" fill="currentColor"/><circle cx="19" cy="18" r="2.2" fill="currentColor"/>' },
    { title: 'The band on the map',                     icon: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>' },
];

function guideStatus() {
    const t = active;
    const m = getMeasurements(t);
    if (!t.img && !m) return { idx: 0, hint: 'Drop or paste an image, or browse · no photo? type H and L above' };
    if (dtEpoch(t) == null) {
        return dtFilled(t) ? { idx: 1, hint: 'That date or time does not exist · check it', cls: 'bad' }
                           : { idx: 1, hint: 'Enter the capture date and time' };
    }
    if (!m) {
        if (t.points.length < 3) return { idx: 2, hint: POINT_HINTS[t.points.length] };
        return { idx: 2, hint: 'The shadow is too short · drag the points apart', cls: 'bad' };
    }
    if (t.busy || (!t.result && !t.noMatch)) return { idx: 3, hint: 'Calculating…' };
    if (t.noMatch) return { idx: 3, hint: 'No place on Earth matches · check the points and the time', cls: 'bad' };
    return { idx: GUIDE_STEPS.length, hint: m.fromPoints ? 'Drag a point to refine the band' : '', cls: 'done' };
}

function buildGuide() {
    const g = $('guide');
    g.innerHTML = '<div class="guide-rail"><div class="guide-rail-fill"></div></div>';
    GUIDE_STEPS.forEach((st, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'guide-step';
        b.title = st.title;
        b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${st.icon}</svg>`;
        b.addEventListener('click', () => guideAction(i));
        g.appendChild(b);
    });
}

// Clicking the current step does it where it can.
function guideAction(i) {
    const { idx } = guideStatus();
    if (i === 0 && idx === 0) $('file-picker').click();
    else if (i === 1 && idx === 1) focusFirstEmptySeg();
    else if (i === 3 && active.result) {
        if (showMode === 'all' && observations.length >= 2 && overlapCount() > 0) frameOverlap();
        else frameBand(active.result.grid);
    }
}

function updateGuide() {
    syncResetTime();
    updateSunReadout();
    const { idx, hint, cls } = guideStatus();
    $('guide').querySelectorAll('.guide-step').forEach((b, i) => {
        b.classList.toggle('done', i < idx);
        b.classList.toggle('current', i === idx);
    });
    $('guide').querySelector('.guide-rail-fill').style.height = `${Math.min(1, idx / (GUIDE_STEPS.length - 1)) * 100}%`;
    const h = $('image-hint');
    h.textContent = hint;
    h.className = 'step-hint' + (cls ? ' ' + cls : '');
}
buildGuide();

// ---- AUTO-CALCULATE ----

// Called after any change to a tab's input: refreshes the left side and recalculates the band
// shortly after typing (or dragging) stops, once the input is complete. A quiet update (a point
// being dragged) does not pulse the band.
function onInputChanged(t, { delay = 350, quiet = false } = {}) {
    if (t === active) { updateMeasureUI(); updateGuide(); }
    clearTimeout(t.timer);
    if (!getMeasurements(t) || dtEpoch(t) == null) return;
    t.quiet = quiet;
    t.timer = setTimeout(() => calculateTab(t), delay);
}

async function calculateTab(t) {
    const m = getMeasurements(t);
    const baseEpochMs = dtEpoch(t);
    if (!m || baseEpochMs == null) return;
    const quiet = t.quiet; t.quiet = false;
    const token = ++t.token;
    t.busy = true;
    if (t === active) updateGuide();
    renderTabs();
    try {
        const tzGrid = t.mode === 'local' ? await loadTzGrid(new Date(baseEpochMs)) : null;
        await new Promise(r => setTimeout(r, 20));   // let "Calculating…" paint
        if (token !== t.token || !tabs.includes(t)) return;
        const { grid, count } = findShadows(baseEpochMs, m.h, m.s, t.mode, tzGrid);
        t.noMatch = !count;
        t.result = count ? {
            id: t.id, label: formatObsLabel(baseEpochMs, t.mode),
            baseEpochMs, mode: t.mode, h: m.h, s: m.s, grid,
        } : null;
        syncObservations();
        await renderBands();
        if (count) {
            // The first result of a tab turns the map: to the overlap once there are two or more
            // bands, else to the ring's centre (where the sun is overhead). Local-mode bands are
            // not rings, so they, and every later update, just pulse.
            const overlap = overlapCount();
            const oneShown = showMode === 'one' || observations.length === 1;
            if (!t.framed && !oneShown && overlap > 0) frameOverlap();
            else if (!t.framed && oneShown && t.mode === 'utc') frameBand(grid);
            else if (!quiet) pulseBand();
            t.framed = true;
            if (overlap === 0 && !quiet) {
                showToast('These bands do not overlap. Check the times, and that every shot is the same place.');
            }
        }
        refreshPinPopup();
    } catch (err) {
        showToast('Calculation failed: ' + err.message);
    } finally {
        if (token === t.token) t.busy = false;
        if (t === active) updateGuide();
        renderTabs();
    }
}

// ---- TIMEZONE GRID ----

let tzGridRaw = null;

async function loadTzGrid(forDate) {
    if (!tzGridRaw) {
        const resp = await fetch('timezone_grid.json');
        tzGridRaw = await resp.json();
    }
    // Build offset map for the specific photo date so DST is handled correctly
    const offsetMap = new Map();
    for (const tz of new Set(tzGridRaw.timezones)) {
        offsetMap.set(tz, getTzOffsetMinutes(tz, forDate));
    }
    return { ...tzGridRaw, _offsetMap: offsetMap };
}

function getTzOffsetMinutes(tzName, date) {
    try {
        const localStr = new Intl.DateTimeFormat('sv', {
            timeZone: tzName,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false
        }).format(date);
        const localMs = new Date(localStr.replace(' ', 'T') + 'Z').getTime();
        return Math.round((localMs - date.getTime()) / 60000);
    } catch {
        return 0;
    }
}

// ---- SHADOW MATH ----

function findShadows(baseEpochMs, objectHeight, shadowLength, mode, tzGrid) {
    // Layout (GRID, MATCH_TOL) is shared with contours.js, which outlines the band.
    const lats = [];
    for (let i = 0; i < GRID.rows; i++) lats.push(GRID.minLat + i * GRID.res);
    const lons = [];
    for (let j = 0; j < GRID.cols; j++) lons.push(GRID.minLon + j * GRID.res);

    const numLons = lons.length;
    const offsetMap = tzGrid?._offsetMap;

    // grid holds the relative shadow-length error per cell, continuous so the band edge can be
    // interpolated between cells (Infinity = sun below the horizon). A cell is in the band
    // when its error is below MATCH_TOL. One grid per observation.
    const grid = new Float32Array(lats.length * numLons).fill(Infinity);
    let count = 0;

    for (let i = 0; i < lats.length; i++) {
        for (let j = 0; j < numLons; j++) {
            const lat = lats[i], lon = lons[j];

            let dt;
            if (mode === 'local' && offsetMap) {
                const tzName = tzGrid.timezones[i * numLons + j];
                const offsetMin = offsetMap.get(tzName) ?? 0;
                dt = new Date(baseEpochMs - offsetMin * 60000);
            } else {
                dt = new Date(baseEpochMs);
            }

            const alt = SunCalc.getPosition(dt, lat, lon).altitude;
            if (alt <= 0) continue;

            const calcShadow = objectHeight / Math.tan(alt);
            const diff = Math.abs(calcShadow - shadowLength) / shadowLength;
            grid[i * numLons + j] = diff;
            if (diff < MATCH_TOL) count++;
        }
    }

    return { grid, count };
}

// ---- RENDER: BANDS AND DAYLIGHT ----

// Bands and the daylight wash are painted into images pinned to lat/lon boxes, which MapLibre
// drapes over the globe (or flat map) like any other layer. MapLibre stretches an image evenly
// in Web Mercator between its corners, so image rows are spaced in Mercator y.
const BAND_SOURCE = 'bands', BAND_LAYER = 'bands';
const DAY_SOURCE  = 'daylight', DAY_LAYER = 'daylight';
const MERC_MAX_LAT = 85.05112878;
const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
const latOfMercY = y => Math.atan(Math.sinh(y)) * 180 / Math.PI;

const BAND_IMG_W  = 1440;   // 2 px per 0.5° grid column
const BAND_MERC_TOP = mercY(GRID.maxLat), BAND_MERC_BOT = mercY(GRID.minLat);
const BAND_IMG_H  = Math.round((BAND_MERC_TOP - BAND_MERC_BOT) / (2 * Math.PI) * BAND_IMG_W);

// Grid row / column for each image row / column (nearest cell).
const BAND_ROW_GI = new Int32Array(BAND_IMG_H);
for (let py = 0; py < BAND_IMG_H; py++) {
    const lat = latOfMercY(BAND_MERC_TOP - (py + 0.5) / BAND_IMG_H * (BAND_MERC_TOP - BAND_MERC_BOT));
    BAND_ROW_GI[py] = Math.min(GRID.rows - 1, Math.max(0, Math.floor((lat - GRID.minLat) / GRID.res)));
}
const BAND_COL_GJ = new Int32Array(BAND_IMG_W);
for (let px = 0; px < BAND_IMG_W; px++) {
    const lon = GRID.minLon + (px + 0.5) / BAND_IMG_W * (GRID.maxLon - GRID.minLon);
    BAND_COL_GJ[px] = Math.min(GRID.cols - 1, Math.floor((lon - GRID.minLon) / GRID.res));
}

// Bright where every band matches (fading with the match error), faint gold where only some do.
function paintBandImage(obs) {
    const img = new ImageData(BAND_IMG_W, BAND_IMG_H);
    const d = img.data;
    const n = obs.length;
    for (let py = 0; py < BAND_IMG_H; py++) {
        const base = BAND_ROW_GI[py] * GRID.cols;
        for (let px = 0; px < BAND_IMG_W; px++) {
            const idx = base + BAND_COL_GJ[px];
            let matchCount = 0, sumDiff = 0;
            for (let k = 0; k < n; k++) {
                const dff = obs[k].grid[idx];
                if (dff < MATCH_TOL) { matchCount++; sumDiff += dff; }
            }
            const i4 = (py * BAND_IMG_W + px) * 4;
            if (matchCount === n) {
                const t = (sumDiff / n) / MATCH_TOL;
                d[i4] = 255; d[i4+1] = (179 * (1 - t)) | 0; d[i4+2] = 0; d[i4+3] = (220 * (1 - t)) | 0;
            } else if (matchCount > 0) {
                d[i4] = 255; d[i4+1] = 179; d[i4+2] = 0; d[i4+3] = 38;
            }
        }
    }
    return img;
}

// Daylight wash for one UTC moment, over the whole map (not just the band's 60°S–85°N grid), so
// polar day and polar night show with the seasons. Sun altitude is sampled every degree and
// interpolated per pixel; the edge fades across ±0.5° of altitude.
const DAY_IMG_W = 720, DAY_IMG_H = 720;   // Mercator from +85.05° to −85.05° is square
let dayImgFor = null;
function paintDaylightImage(epochMs) {
    const date = new Date(epochMs);
    const NLAT = 181, NLON = 361;   // 1° samples, -90..90 × -180..180
    const alt = new Float32Array(NLAT * NLON);
    for (let a = 0; a < NLAT; a++) {
        for (let o = 0; o < NLON; o++) {
            alt[a * NLON + o] = SunCalc.getPosition(date, a - 90, o - 180).altitude * 180 / Math.PI;
        }
    }
    const img = new ImageData(DAY_IMG_W, DAY_IMG_H);
    const d = img.data;
    const top = Math.PI;   // mercY(MERC_MAX_LAT)
    for (let py = 0; py < DAY_IMG_H; py++) {
        const lat = latOfMercY(top - (py + 0.5) / DAY_IMG_H * 2 * top);
        const fa = lat + 90, a0 = Math.floor(fa), ta = fa - a0;
        for (let px = 0; px < DAY_IMG_W; px++) {
            const fo = (px + 0.5) / DAY_IMG_W * 360, o0 = Math.floor(fo), to = fo - o0;
            const i00 = a0 * NLON + o0;
            const v = (alt[i00] * (1 - to) + alt[i00 + 1] * to) * (1 - ta) +
                      (alt[i00 + NLON] * (1 - to) + alt[i00 + NLON + 1] * to) * ta;
            const k = Math.min(1, Math.max(0, v + 0.5));
            if (!k) continue;
            const i4 = (py * DAY_IMG_W + px) * 4;
            d[i4] = 255; d[i4+1] = 179; d[i4+2] = 0; d[i4+3] = (18 * k) | 0;
        }
    }
    return img;
}

function setImageLayer(sourceId, layerId, coords, image, beforeId) {
    const src = map.getSource(sourceId);
    if (src) {
        src.updateImage({ image });
    } else {
        map.addSource(sourceId, { type: 'image', coordinates: coords });
        map.getSource(sourceId).updateImage({ image });
        map.addLayer({
            id: layerId, type: 'raster', source: sourceId,
            paint: { 'raster-opacity': resultOpacity, 'raster-fade-duration': 0, 'raster-resampling': layerId === BAND_LAYER ? 'nearest' : 'linear' },
        }, beforeId && map.getLayer(beforeId) ? beforeId : undefined);
    }
    map.setLayoutProperty(layerId, 'visibility', 'visible');
}
const hideLayer = id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none'); };

async function renderBands() {
    $('opacity-wrap').style.display = observations.length ? 'flex' : 'none';
    $('show-toggle').hidden = observations.length < 2;
    syncShowToggle();
    await mapReady;
    const shown = visibleObservations();
    if (!shown.length) { hideLayer(BAND_LAYER); hideLayer(DAY_LAYER); return; }

    setImageLayer(BAND_SOURCE, BAND_LAYER,
        [[GRID.minLon, GRID.maxLat], [GRID.maxLon, GRID.maxLat], [GRID.maxLon, GRID.minLat], [GRID.minLon, GRID.minLat]],
        paintBandImage(shown));

    // The daylight wash only makes sense for a single UTC moment.
    const one = shown.length === 1 && shown[0].mode !== 'local' ? shown[0] : null;
    if (!one) { hideLayer(DAY_LAYER); return; }
    if (dayImgFor !== one.baseEpochMs || !map.getSource(DAY_SOURCE)) {
        dayImgFor = one.baseEpochMs;
        setImageLayer(DAY_SOURCE, DAY_LAYER,
            [[-180, MERC_MAX_LAT], [180, MERC_MAX_LAT], [180, -MERC_MAX_LAT], [-180, -MERC_MAX_LAT]],
            paintDaylightImage(one.baseEpochMs), BAND_LAYER);
    } else {
        map.setLayoutProperty(DAY_LAYER, 'visibility', 'visible');
    }
}

// A short glow on the band, to show it was updated without moving the map.
let pulseRaf = 0;
function pulseBand() {
    if (!map.getLayer(BAND_LAYER)) return;
    cancelAnimationFrame(pulseRaf);
    const t0 = performance.now(), dur = 650;
    const step = now => {
        const t = Math.min(1, (now - t0) / dur);
        const k = Math.sin(t * Math.PI);
        map.setPaintProperty(BAND_LAYER, 'raster-opacity', resultOpacity + (1 - resultOpacity) * k);
        map.setPaintProperty(BAND_LAYER, 'raster-brightness-min', 0.35 * k);
        if (t < 1) pulseRaf = requestAnimationFrame(step);
    };
    pulseRaf = requestAnimationFrame(step);
}

// Turns the map to face a new band: the centre of its matching cells, averaged as 3D unit
// vectors so a band across the antimeridian or around a pole still gets a sensible centre.
// Each cell is weighted by its area (cos lat): grid cells shrink toward the poles, and an
// unweighted average would pull a ring's centre poleward.
function frameBand(grid) { frameCells(idx => grid[idx] < MATCH_TOL); }

// With two or more bands, the overlap is what matters: turn the map to its centre.
function frameOverlap() {
    frameCells(idx => observations.every(o => o.grid[idx] < MATCH_TOL));
}

function frameCells(inside) {
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < GRID.rows; i++) {
        const lat = (GRID.minLat + i * GRID.res) * Math.PI / 180;
        const cl = Math.cos(lat), sl = Math.sin(lat);
        for (let j = 0; j < GRID.cols; j++) {
            if (!inside(i * GRID.cols + j)) continue;
            const lon = (GRID.minLon + j * GRID.res) * Math.PI / 180;
            x += cl * cl * Math.cos(lon); y += cl * cl * Math.sin(lon); z += cl * sl;
        }
    }
    if (!x && !y && !z) return;
    const lon = Math.atan2(y, x) * 180 / Math.PI;
    const lat = Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI;
    map.flyTo({ center: [lon, lat], zoom: frameZoom(), bearing: 0, pitch: 0 });
}

function formatObsLabel(baseEpochMs, mode) {
    const dt = new Date(baseEpochMs);
    const p = pad2;
    return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())} ` +
           `${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())} ${mode === 'local' ? 'Local' : 'UTC'}`;
}

// number of cells that fall inside every band (the intersection); -1 when < 2 observations
function overlapCount() {
    if (observations.length < 2) return -1;
    const N = observations[0].grid.length;
    let c = 0;
    for (let idx = 0; idx < N; idx++) {
        let all = true;
        for (let k = 0; k < observations.length; k++) {
            if (!(observations[k].grid[idx] < MATCH_TOL)) { all = false; break; }
        }
        if (all) c++;
    }
    return c;
}

// ---- SHOW THIS / ALL BANDS ----

function syncShowToggle() {
    document.querySelectorAll('#show-toggle .toggle-btn').forEach(b =>
        b.classList.toggle('active-toggle', b.dataset.show === showMode));
}
document.querySelectorAll('#show-toggle .toggle-btn').forEach(b => b.addEventListener('click', () => {
    if (showMode === b.dataset.show) return;
    showMode = b.dataset.show;
    renderBands();
}));

// ---- COORDINATE PIN (map bar, or Ctrl+V anywhere) ----
// One pin at a time, to see whether a roughly known place lies in the bands.

const RAD = 180 / Math.PI;
const validLatLng = (lat, lng) =>
    Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;

// "52.39, 13.06", "52.39° N, 13.06° E", "52°23'24"N 13°03'36"E", Web Mercator metres, and links
// from Google Maps, Apple, Bing, OpenStreetMap, Yandex or anything with lat=/lon=.
// After TracePoint's parser. Returns { lat, lng } or null.
function parseCoordinates(text) {
    const s = String(text || '').trim();
    if (!s || s.length > 2000) return null;

    if (/^https?:\/\//i.test(s)) {
        const known = parseCoordinateUrl(s);
        if (known !== undefined) return known;
        const m = s.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/) ||
                  s.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/) ||
                  s.match(/[?&](?:q|ll|query|center)=(-?\d+(?:\.\d+)?)(?:,|%2C)\s*(-?\d+(?:\.\d+)?)/i);
        return m ? validLatLng(+m[1], +m[2]) : null;
    }

    const merc = s.match(/^@?\s*([-+]?\d+(?:\.\d+)?)\s*[,;\s]\s*([-+]?\d+(?:\.\d+)?)$/);
    if (merc) {
        const x = +merc[1], y = +merc[2], R = 6378137, MAX = Math.PI * R;
        if (Math.max(Math.abs(x), Math.abs(y)) > 1000 && Math.abs(x) <= MAX && Math.abs(y) <= MAX) {
            return validLatLng(Math.atan(Math.sinh(y / R)) * RAD, x / R * RAD);
        }
    }

    const norm = s.replace(/[″“”]|''/g, '"').replace(/[′‘’]/g, "'");
    const PART = /(?<![A-Za-z])([NSEW])?\s*([-+]?\d+(?:\.\d+)?)\s*°?\s*(?:(\d+(?:\.\d+)?)\s*'\s*)?(?:(\d+(?:\.\d+)?)\s*"\s*)?([NSEW](?![A-Za-z]))?/gi;
    const parts = [];
    for (const m of norm.matchAll(PART)) {
        const [, pre, deg, min, sec, post] = m;
        if ((min && +min >= 60) || (sec && +sec >= 60)) return null;
        const hemi = (pre || post || '').toUpperCase();
        let v = Math.abs(+deg) + (min ? +min / 60 : 0) + (sec ? +sec / 3600 : 0);
        if (deg.startsWith('-') || hemi === 'S' || hemi === 'W') v = -v;
        parts.push({ v, hemi });
    }
    if (parts.length !== 2) return null;
    let [a, b] = parts;
    if (/[EW]/.test(a.hemi) || /[NS]/.test(b.hemi)) [a, b] = [b, a];
    else if (!a.hemi && !b.hemi && Math.abs(a.v) > 90 && Math.abs(b.v) <= 90) [a, b] = [b, a];
    return validLatLng(a.v, b.v);
}

// A known map service is read by its own rules (Yandex writes longitude first); undefined means
// "not a known service", so the generic rules get their turn.
function parseCoordinateUrl(s) {
    let url;
    try { url = new URL(s); } catch { return null; }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const q = url.searchParams, hash = new URLSearchParams(url.hash.slice(1));
    const NUM = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
    const pair = (text, sep = ',', lngFirst = false) => {
        const m = (text || '').match(new RegExp(`^\\s*(${NUM})\\s*${sep}\\s*(${NUM})\\s*$`));
        return m ? validLatLng(+m[lngFirst ? 2 : 1], +m[lngFirst ? 1 : 2]) : null;
    };
    if (host === 'maps.apple.com') return pair(q.get('coordinate') ?? q.get('ll') ?? q.get('q'));
    if (host === 'bing.com')       return pair(q.get('cp'), '~');
    if (/^yandex\.[a-z.]+$/.test(host)) return pair(q.get('ll'), ',', true);
    if (host === 'openstreetmap.org' || host === 'osm.org') {
        if (q.has('mlat') && q.has('mlon')) return pair(`${q.get('mlat')},${q.get('mlon')}`);
        const view = hash.get('map')?.split('/');
        return view?.length === 3 ? pair(`${view[1]},${view[2]}`) : null;
    }
    if (q.has('lat') && (q.has('lon') || q.has('lng'))) return pair(`${q.get('lat')},${q.get('lon') ?? q.get('lng')}`);
    return undefined;
}

// ---- SUN READOUT (map bar) ----
// For the selected shadow: the sun's altitude (from H/L), the ring's radius (90° minus that: how
// far from the overhead point the band lies) and, for a UTC time, where the sun stood overhead,
// which is the ring's centre.

// The point where the sun is at the zenith, from the sun's declination and right ascension and
// Greenwich sidereal time (low-precision almanac formulas, good to ~0.01°).
function subsolarPoint(ms) {
    const d = ms / 86400000 + 2440587.5 - 2451545.0;   // days since J2000.0
    const g = (357.529 + 0.98560028 * d) / RAD;
    const q = 280.459 + 0.98564736 * d;
    const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) / RAD;
    const e = (23.439 - 0.00000036 * d) / RAD;
    const ra  = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) * RAD;
    const dec = Math.asin(Math.sin(e) * Math.sin(L)) * RAD;
    const gmst = 18.697374558 + 24.06570982441908 * d;   // hours
    const lng = ((ra - gmst * 15) % 360 + 540) % 360 - 180;
    return { lat: dec, lng };
}

const fmtLatLng = ({ lat, lng }) =>
    `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lng).toFixed(1)}°${lng >= 0 ? 'E' : 'W'}`;

function updateSunReadout() {
    const el = $('sun-readout');
    const r = active.result;
    if (!r) { el.hidden = true; return; }
    const alt = Math.atan2(r.h, r.s) * RAD;
    const radius = 90 - alt;
    const parts = [
        ['Sun', `${alt.toFixed(1)}°`, 'Sun altitude above the horizon, from the height / shadow ratio'],
        ['Ring', `${radius.toFixed(1)}° · ${Math.round(radius * 111.2).toLocaleString('en')} km`, 'Distance of the band from the point where the sun stood overhead'],
    ];
    if (r.mode === 'utc') {
        parts.push(['Overhead', fmtLatLng(subsolarPoint(r.baseEpochMs)), 'Where the sun stood overhead at that moment: the centre of the ring']);
    }
    el.innerHTML = parts.map(([k, v, t]) => `<span title="${t}"><i>${k}</i><b>${v}</b></span>`).join('');
    el.hidden = false;
}

let coordPin = null;

// Which shadows' bands cover a spot (nearest grid cell), as text for the pin.
function bandsAt(lat, lng) {
    if (lat < GRID.minLat || lat > GRID.maxLat) return 'Outside the calculated area (60°S to 85°N)';
    const i = Math.round((lat - GRID.minLat) / GRID.res);
    const j = ((Math.round((lng - GRID.minLon) / GRID.res) % GRID.cols) + GRID.cols) % GRID.cols;
    const idx = Math.min(GRID.rows - 1, i) * GRID.cols + j;
    const withBand = tabs.filter(t => t.result);
    if (!withBand.length) return 'No band calculated yet';
    const inside = withBand.filter(t => t.result.grid[idx] < MATCH_TOL).map(t => `Shadow ${tabIndex(t)}`);
    if (!inside.length) return 'Outside every band';
    if (inside.length === withBand.length && withBand.length > 1) return 'Inside every band';
    return 'Inside the band of ' + inside.join(', ');
}

function pinHtml(lat, lng) {
    const c = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    return `<div class="tp-popup-header">Pinned location</div>` +
        `<div class="tp-popup-body"><span>${c}</span>` +
        `<button class="tp-copy-btn" data-action="copy-coords" data-coords="${c}" title="Copy coordinates">` +
        `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="9" height="9" rx="1"/><path d="M2 11V2h9"/></svg>` +
        `</button></div>` +
        `<div class="tp-popup-note">${bandsAt(lat, lng)}</div>` +
        `<button class="tp-popup-link" data-action="remove-pin">Remove pin</button>`;
}

function pinLocation({ lat, lng }) {
    removePin();
    const el = document.createElement('div');
    el.className = 'coord-pin';
    const popup = new maplibregl.Popup({ className: 'tp-popup tp-popup-pin', offset: 14, maxWidth: 'none' }).setHTML(pinHtml(lat, lng));
    coordPin = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).setPopup(popup).addTo(map);
    map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 4) });
    map.once('moveend', () => { if (coordPin && !popup.isOpen()) coordPin.togglePopup(); });
}

function removePin() {
    if (coordPin) { coordPin.remove(); coordPin = null; }
}

function refreshPinPopup() {
    if (!coordPin) return;
    const { lat, lng } = coordPin.getLngLat();
    coordPin.getPopup().setHTML(pinHtml(lat, lng));
}

document.addEventListener('click', e => {
    if (e.target.closest('[data-action="remove-pin"]')) removePin();
});

(() => {
    const input = $('coord-input');
    const PLACEHOLDER = input.placeholder;
    const tryPin = () => {
        const ll = parseCoordinates(input.value);
        if (!ll) {
            input.value = '';
            input.classList.add('search-input-error');
            input.placeholder = 'Not recognised · try 52.39, 13.06';
            return;
        }
        input.value = '';
        input.blur();
        pinLocation(ll);
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); tryPin(); } });
    input.addEventListener('paste', () => setTimeout(tryPin, 0));
    input.addEventListener('input', () => { input.classList.remove('search-input-error'); input.placeholder = PLACEHOLDER; });
    input.addEventListener('blur', () => { input.classList.remove('search-input-error'); input.placeholder = PLACEHOLDER; });
})();

// ---- MAP RIGHT-CLICK: the clicked coordinates, to copy ----

const ctxMenu = document.createElement('div');
ctxMenu.className = 'map-ctx-menu';
ctxMenu.style.display = 'none';
$('map-container').appendChild(ctxMenu);
const hideCtxMenu = () => { ctxMenu.style.display = 'none'; };

map.on('contextmenu', e => {
    e.preventDefault();
    const c = `${e.lngLat.lat.toFixed(6)}, ${e.lngLat.lng.toFixed(6)}`;
    ctxMenu.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'map-ctx-head';
    head.textContent = c;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'map-ctx-item';
    copy.textContent = 'Copy coordinates';
    copy.onclick = () => {
        hideCtxMenu();
        navigator.clipboard.writeText(c)
            .then(() => showToast('Coordinates copied.', 'success'))
            .catch(() => showToast('Could not copy to clipboard.'));
    };
    ctxMenu.append(head, copy);
    ctxMenu.style.display = 'block';
    const box = map.getContainer().getBoundingClientRect();
    const w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
    ctxMenu.style.left = `${Math.min(e.point.x, box.width - w - 4)}px`;
    ctxMenu.style.top  = `${Math.min(e.point.y, box.height - h - 4)}px`;
});
map.on('movestart', hideCtxMenu);
map.on('click', hideCtxMenu);
document.addEventListener('mousedown', e => { if (!ctxMenu.contains(e.target)) hideCtxMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideCtxMenu(); });

// ---- OPACITY ----

function paintOpacitySlider() {
    const s = $('opacity-slider');
    const pct = (s.value - s.min) / (s.max - s.min) * 100;
    s.style.background = `linear-gradient(to right, #ffb300 0%, #ffb300 ${pct}%, #5a5a5a ${pct}%, #5a5a5a 100%)`;
}
paintOpacitySlider();

$('opacity-slider').addEventListener('input', e => {
    resultOpacity = parseFloat(e.target.value);
    [BAND_LAYER, DAY_LAYER].forEach(l => { if (map.getLayer(l)) map.setPaintProperty(l, 'raster-opacity', resultOpacity); });
    paintOpacitySlider();
});

// ---- HELP ----

$('btn-help').addEventListener('click', () => {
    const card = $('help-card');
    card.style.display = card.style.display === 'none' ? 'block' : 'none';
});
$('btn-help-close').addEventListener('click', () => { $('help-card').style.display = 'none'; });

// ---- START ----

loadTabIntoUI();
