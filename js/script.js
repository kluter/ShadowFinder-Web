/* ============================================================
   ShadowFinder Web – script.js
   ============================================================ */

const $ = id => document.getElementById(id);
const canvas    = $('image-canvas');
const ctx       = canvas.getContext('2d');
const container = $('image-container');
const overlay   = $('drop-overlay');

// localStorage, without throwing where the browser blocks storage (the app then just forgets).
const prefs = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// ---- TOAST ----

// A toast: the message as text (never markup) and a close button.
function toastItem(msg, cls) {
    const item = document.createElement('div');
    item.className = 'toast-item' + cls;
    const text = document.createElement('span');
    text.textContent = msg;
    const close = document.createElement('button');
    close.className = 'toast-close';
    close.textContent = '×';
    item.append(text, close);
    return item;
}

const toastCounts = new Map();
const TOAST_DURATION = 4500;
const TOAST_MAX_STACK = 3;

function showToast(msg, type = 'error') {
    const count = toastCounts.get(msg) || 0;
    if (count >= TOAST_MAX_STACK) return;
    toastCounts.set(msg, count + 1);
    const tc = $('toast-container');
    const item = toastItem(msg, type === 'success' ? ' toast-success' : '');
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
    const item = toastItem(msg, type === 'warn' ? ' toast-warn' : '');
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
let projection = PROJECTIONS.includes(prefs.get('sf-projection')) ? prefs.get('sf-projection') : 'globe';

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

// The zoom at which the whole globe fits the map panel, with ~40 px to spare top and bottom.
// The globe's radius is 512·2^z / 2π px; seen from the camera (cam px in front of it) its edge
// appears at cam·tan(asin(R / (cam + R))).
function globeFitZoom() {
    const H = map.getContainer().clientHeight, W = map.getContainer().clientWidth;
    const target = Math.max(80, Math.min(H - 80, W - 80) / 2);
    const cam = 0.5 * H / Math.tan(CAMERA_FOV / 2 * Math.PI / 180);
    const t = target / cam, k = t / Math.sqrt(1 + t * t);
    const R = k * cam / (1 - k);
    return Math.log2(2 * Math.PI * R / 512);
}
const frameZoom = () => projection === 'globe' ? globeFitZoom() : 1.2;

async function setProjection(type) {
    projection = PROJECTIONS.includes(type) ? type : 'globe';
    prefs.set('sf-projection', projection);
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
        const a = (big ? 0.7 + rnd() * 0.3 : 0.25 + rnd() * 0.45) * 0.82;
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
// ---- IDLE SPIN ----
// While the app is just open and untouched, the globe turns slowly eastward, as the Earth does:
// seen from space with north up, the surface drifts from left to right, so the view's centre
// moves west. The first click, key, scroll, paste or drop anywhere stops it for good, so it never
// fights the user or the map's own flights. Not with a restored session, nor in 2D, nor when the
// system asks for reduced motion.
const SPIN_DEG_PER_SEC = 3;   // one turn in two minutes
const SPIN_STOP_EVENTS = ['pointerdown', 'keydown', 'wheel', 'paste', 'drop'];
let spinRaf = 0;
function stopIdleSpin() {
    cancelAnimationFrame(spinRaf);
    spinRaf = 0;
    SPIN_STOP_EVENTS.forEach(t => document.removeEventListener(t, stopIdleSpin, true));
}
async function startIdleSpin() {
    const still = () => projection === 'globe' && !hasWork() && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!still()) return;
    await mapReady;
    if (!still()) return;
    SPIN_STOP_EVENTS.forEach(t => document.addEventListener(t, stopIdleSpin, { capture: true, passive: true }));
    let last = performance.now();
    const step = now => {
        const dt = Math.min(0.1, (now - last) / 1000);   // no jump after the tab was in the background
        last = now;
        const c = map.getCenter();
        map.jumpTo({ center: [((c.lng - SPIN_DEG_PER_SEC * dt + 540) % 360) - 180, c.lat] });
        spinRaf = requestAnimationFrame(step);
    };
    spinRaf = requestAnimationFrame(step);
}

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
    prefs.set('sf-tileset', set.id);
    $('basemap-name').textContent = set.label;
    document.querySelectorAll('#basemap-menu .layer-item').forEach(i =>
        i.classList.toggle('active', i.dataset.id === set.id));

    await mapReady;
    applyPalette(set.id);   // the bands' colours follow the base map
    activeBaseIds.forEach(lid => { map.removeLayer(lid); map.removeSource(lid); });
    activeBaseIds = [];
    // Basemap layers go under the daylight, band and overlap layers when they exist.
    const beforeId = map.getStyle().layers.map(l => l.id).find(id => id !== 'background' && !id.startsWith('base-'));
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
setTileSet(prefs.get('sf-tileset') || 'dark');

// ---- OBSERVATIONS (one per tab) ----
//
// Every tab is one observation: a photo with three marked points, or just a typed height and
// shadow length, plus the capture time. A tab's band is recalculated whenever its input is
// complete; `observations` is the list of bands currently on the map.

const ADJUST_DEFAULT = { contrast: 100, brightness: 100, saturation: 100, invert: false };

let tabSeq = 0;
// Names a tab's photo in the autosave: a new photo gets a new one, so it is stored afresh.
const newUid = () => crypto.randomUUID ? crypto.randomUUID() : 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2);
function newTab() {
    return {
        id: ++tabSeq,
        uid: newUid(),
        img: null,          // HTMLImageElement of the photo, if any
        imageFile: null,    // the photo as a file (session export with photos, autosave)
        pendingImage: '',   // restored session: the file name of the photo it waits for
        opacity: null,      // band opacity set in the Layers dropdown (null = default)
        gpsMarker: null,    // the photo's EXIF GPS position on the map, when shown
        bandImgFor: null,   // the result its map layer was painted for
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
        adjust: { ...ADJUST_DEFAULT },   // display-only contrast / brightness / saturation / invert
        timer: 0, token: 0,
    };
}

let tabs = [newTab()];
let active = tabs[0];
let observations = [];
// Bands on the map: 'all' (their overlap is the location) or 'one' (only the selected shadow's)
let showMode = 'all';

function syncObservations() {
    observations = tabs.filter(t => t.result).map(t => t.result);
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
    scheduleAutosave();
}

function addTab() {
    if (tabs.length >= MAX_OBS) return;
    const t = newTab();
    tabs.push(t);
    switchTab(t);
}

// Stops a tab's pending or running calculation (a running one sees the new token and drops its result).
function cancelCalc(t) {
    clearTimeout(t.timer);
    t.token++;
    t.busy = false;
}

function removeTab(t) {
    cancelCalc(t);
    removeExifGps(t);   // its GPS pin goes with it
    if (tabs.length === 1) {
        // closing the last shadow is the clear-all: start fresh
        tabs = [newTab()];
        active = tabs[0];
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
    renderBands();   // the daylight and the centre button follow the selected shadow
}

// Shows the active tab on the left: photo, points, typed values, time and zone.
function loadTabIntoUI() {
    const t = active;
    img = t.img;
    points = t.points;
    updateDropOverlay();
    if (img) {
        canvas.style.display = 'block';
        overlay.style.display = 'none';
        if (t.view && !t.view.fitted) { fitCanvasToContainer(); ({ scale, offsetX, offsetY } = t.view); viewFitted = false; }
        else fitImage();
    } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.style.display = 'none';
        overlay.style.display = '';
    }
    canvas.style.cursor = idleCursor();
    showOriginal = false;
    $('adjust-card').style.display = 'none';
    syncPhotoTools();
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
    if (active && active.img) active.view = { scale, offsetX, offsetY, fitted: viewFitted };
}

// ---- PHOTO ----

let img = null;
let points = [];
let scale = 1, offsetX = 0, offsetY = 0;
let viewFitted = true;   // the photo is as fitImage() placed it (not zoomed or panned since)
let isPanning = false, panStartX = 0, panStartY = 0, panOffsetX = 0, panOffsetY = 0;
let spaceHeld = false;

// Loads a photo into a tab (the active one by default). A new photo is a new observation in
// that tab, so its points and band are dropped; its EXIF capture time is used when there is one.
// A photo for a restored session (from a file, the autosave, or dropped where the tab asks for
// it) keeps the tab's points, time and settings instead.
// onReady(tab) runs once both the image and its EXIF are read.
function loadImage(file, tab = active, onReady = null, { restore = !!tab.pendingImage } = {}) {
    const url = URL.createObjectURL(file);
    const image = new Image();
    const imageLoaded = new Promise((resolve, reject) => {
        image.onload = () => {
            URL.revokeObjectURL(url);   // decoded: the image draws without it
            if (!restore) tab.uid = newUid();
            tab.img = image;
            tab.imageFile = file;
            tab.fileName = file.name || '';
            tab.pendingImage = '';
            if (!restore) {
                removeExifGps(tab);   // a new photo: the old photo's GPS pin goes
                tab.points.length = 0;
                tab.view = null;
                tab.adjust = { ...ADJUST_DEFAULT };
                tab.result = null; tab.noMatch = false; tab.framed = false;
                syncObservations();
                renderBands();
            }
            if (tab === active) loadTabIntoUI(); else renderTabs();
            resolve();
        };
        image.onerror = () => { URL.revokeObjectURL(url); showToast('Could not load image.'); reject(); };
    });
    image.src = url;

    // reviveValues off: the dates stay the text written in the file. Revived, exifr builds them
    // in this browser's time zone, which moves a time inside a daylight-saving gap by an hour.
    const exifRead = exifr.parse(file, { tiff: true, exif: true, gps: true, reviveValues: false })
        .then(exif => { tab.exif = exif || null; })
        .catch(() => { tab.exif = null; });
    if (!restore) { tab.exif = null; tab.exifDt = null; }

    Promise.all([imageLoaded, exifRead]).then(() => {
        if (restore) {
            tab.exifDt = readExifTime(tab.exif);   // the chip again, without touching the kept time
            if (tab === active) { syncExifChip(); updateGuide(); }
            if (onReady) onReady(tab);
            scheduleAutosave();
            return;
        }
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
    viewFitted = true;
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
    const f = photoFilter();
    if (f) ctx.filter = f;
    ctx.drawImage(img, 0, 0);
    ctx.restore();
    drawPoints();
    if (points.length >= 2) drawLine(points[0], points[1], POINT_COLORS[0]);
    if (points.length === 3) drawLine(points[0], points[2], POINT_COLORS[2]);
}

// ---- PHOTO TOOLS: fit, display adjustments, show original (as in TracePoint) ----

let showOriginal = false;
const isAdjusted = a => a.contrast !== 100 || a.brightness !== 100 || a.saturation !== 100 || a.invert;

function photoFilter() {
    const a = active.adjust;
    if (showOriginal || !isAdjusted(a)) return '';
    return `contrast(${a.contrast}%) brightness(${a.brightness}%) saturate(${a.saturation}%)${a.invert ? ' invert(1)' : ''}`;
}

function syncPhotoTools() {
    const a = active.adjust;
    scheduleAutosave();
    $('photo-tools').hidden = !active.img;
    ['contrast', 'brightness', 'saturation'].forEach(k => {
        $(`adjust-${k}`).value = a[k];
        $(`adjust-${k}-val`).textContent = a[k] + '%';
    });
    $('adjust-invert').checked = a.invert;
    $('adjust-invert-val').textContent = a.invert ? 'On' : 'Off';
    const adjusted = isAdjusted(a);
    if (!adjusted) showOriginal = false;
    $('btn-original').disabled = !adjusted;
    $('btn-original').classList.toggle('active-mode', showOriginal);
    $('btn-original').setAttribute('aria-pressed', String(showOriginal));
    $('btn-adjust').classList.toggle('active-mode', adjusted);
}

$('btn-fit').addEventListener('click', () => { if (!img) return; fitImage(); drawCanvas(); });

['contrast', 'brightness', 'saturation'].forEach(k => $(`adjust-${k}`).addEventListener('input', e => {
    active.adjust[k] = +e.target.value;
    showOriginal = false;
    syncPhotoTools(); drawCanvas();
}));
$('adjust-invert').addEventListener('change', e => {
    active.adjust.invert = e.target.checked;
    showOriginal = false;
    syncPhotoTools(); drawCanvas();
});
$('btn-adjust-reset').addEventListener('click', () => {
    active.adjust = { ...ADJUST_DEFAULT };
    syncPhotoTools(); drawCanvas();
});
$('btn-original').addEventListener('click', () => {
    showOriginal = !showOriginal;
    syncPhotoTools(); drawCanvas();
});
$('btn-adjust').addEventListener('click', e => {
    e.stopPropagation();
    const card = $('adjust-card');
    card.style.display = card.style.display === 'none' ? 'block' : 'none';
});
document.addEventListener('click', e => { if (!$('adjust-wrap').contains(e.target)) $('adjust-card').style.display = 'none'; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('adjust-card').style.display = 'none'; });

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
    // the click that ends a drag places no point; released off the photo, no click follows
    suppressClick = e.target === canvas;
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
    viewFitted = false;
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
    viewFitted = false;
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
// Space released in another window never reaches this one
window.addEventListener('blur', () => { spaceHeld = false; });

// A new size of the photo panel (the window, or the divider) refits a photo that was fitted; a
// zoomed or panned one keeps its zoom, with the same spot of the photo in the middle.
new ResizeObserver(() => {
    if (!img || !container.clientWidth) return;   // no photo, or the photo side is folded away
    if (viewFitted) fitImage();
    else {
        const c = canvasToImage(canvas.width / 2, canvas.height / 2);
        fitCanvasToContainer();
        offsetX = canvas.width / 2 - c.x * scale;
        offsetY = canvas.height / 2 - c.y * scale;
    }
    drawCanvas();
}).observe(container);

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
    // a shadow that already has its band keeps it: the photo starts a new shadow (at the cap it
    // replaces the current one's photo, as before)
    if (active.img && active.result && tabs.length < MAX_OBS) { const t = newTab(); tabs.push(t); switchTab(t); }
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
    if (typeof val === 'string') {
        // the digits as written, formatted in UTC so this browser's zone cannot shift them
        const m = val.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
        if (m) return new Date(Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]))
            .toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
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
    if (!quiet) showToast(ext.offset
        ? `Date and time taken from the photo's EXIF, converted to UTC with its offset (${ext.offset}). Check them before relying on the result.`
        : "Date and time taken from the photo's EXIF, read as UTC (it has no time-zone offset). Check them before relying on the result.", 'success');
    return true;
}

// Each EXIF time with the offset tag that belongs to it.
const EXIF_TIME_TAGS = [['DateTimeOriginal', 'OffsetTimeOriginal'], ['DateTimeDigitized', 'OffsetTimeDigitized'], ['DateTime', 'OffsetTime']];

// The capture time in an EXIF record, as { dt, mode, offset }, or null.
function readExifTime(ex) {
    if (!ex) return null;
    const tags = EXIF_TIME_TAGS.find(([k]) => ex[k] != null);
    if (!tags) return null;
    // exifr leaves dates as the text written in the file (reviveValues off), and so does a session
    const m = String(ex[tags[0]]).match(/^(\d{4})[: -](\d{2})[: -](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    const year = +m[1], month = +m[2], day = +m[3];
    const hour = +m[4], minute = +m[5], second = m[6] ? +m[6] : 0;
    // A camera whose clock was never set writes "0000:00:00 00:00:00": no time at all.
    if (year < 1900 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) ||
        hour > 23 || minute > 59 || second > 59) return null;

    // An offset tag ("+02:00") says how far the camera's clock was from UTC, so the exact UTC
    // instant follows from it: better than Local mode, which assumes the zone of every place.
    // With no offset the value is taken as already UTC (e.g. images prepared with the capture
    // time written in UTC); the user can switch to Local.
    const offsetStr = pick(ex, tags[1], 'OffsetTimeOriginal', 'OffsetTime', 'OffsetTimeDigitized');
    const om = typeof offsetStr === 'string' && offsetStr.match(/^\s*([+-])(\d{2}):(\d{2})/);
    let ms = Date.UTC(year, month - 1, day, hour, minute, second);
    if (om) ms -= (om[1] === '-' ? -1 : 1) * (+om[2] * 60 + +om[3]) * 60000;
    const u = new Date(ms);
    return {
        dt: { y: String(u.getUTCFullYear()), mo: pad2(u.getUTCMonth() + 1), d: pad2(u.getUTCDate()),
              h: pad2(u.getUTCHours()), mi: pad2(u.getUTCMinutes()), s: pad2(u.getUTCSeconds()) },
        mode: 'utc',
        offset: om ? om[0].trim() : '',
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
               : gps   ? (t.gpsMarker ? "Time from the photo's EXIF. Click to remove its GPS pin from the map."
                                      : "Time from the photo's EXIF. Click to show where it was taken (GPS) on the map.")
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
        const gpsBtn = gps ? `<button class="exif-gps-btn" id="btn-exif-gps">${crosshair}${active.gpsMarker ? 'Remove from map' : 'Show on map'}</button>` : '';

        card.innerHTML =
            '<div class="exif-card-header">Photo metadata (EXIF)</div>' +
            (rows.length ? `<table class="exif-table">${tableRows}</table>` : '<p class="exif-empty">No relevant metadata found.</p>') +
            gpsBtn;

        card.querySelector('#btn-exif-gps')?.addEventListener('click', () => {
            toggleExifGps(active);
            card.style.display = 'none';
        });
        card.querySelectorAll('.exif-copy-btn').forEach(btn => {
            btn.addEventListener('click', () => navigator.clipboard.writeText(btn.dataset.coords).catch(() => {}));
        });
    } catch {
        card.innerHTML = '<p class="exif-empty">Could not read metadata.</p>';
    }
}

// The photo's GPS position as a pin on the map, one per shadow (as in TracePoint): "Show on map"
// puts it there, and with the pin there the same control reads "Remove from map". The pin goes
// with its shadow: closing the tab, a new photo in it, an imported or cleared session.
function toggleExifGps(t) {
    if (t.gpsMarker) { removeExifGps(t); return; }
    const gps = exifGps(t.exif);
    if (!gps) return;
    const { lat, lng } = gps;
    const el = document.createElement('div');
    el.className = 'exif-gps-marker';
    const exifCoords = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    const popup = new maplibregl.Popup({ className: 'tp-popup tp-popup-exif', offset: 14, maxWidth: 'none' })
        .setHTML(
            `<div class="tp-popup-header">Shadow ${tabIndex(t)} · EXIF GPS position</div>` +
            `<div class="tp-popup-body">` +
            `<span>${exifCoords}</span>` +
            `<button class="tp-copy-btn" data-action="copy-coords" data-coords="${exifCoords}" title="Copy coordinates">` +
            `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">` +
            `<rect x="5" y="5" width="9" height="9" rx="1"/><path d="M2 11V2h9"/>` +
            `</svg></button>` +
            `</div>` +
            `<button class="tp-popup-link" data-action="remove-gps" data-tab="${t.id}">Remove from map</button>`
        );
    t.gpsMarker = new maplibregl.Marker({ element: el })
        .setLngLat([lng, lat])
        .setPopup(popup)
        .addTo(map);
    map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 10) });
    map.once('moveend', () => { if (t.gpsMarker && !popup.isOpen()) t.gpsMarker.togglePopup(); });
    if (t === active) syncExifChip();
}

function removeExifGps(t) {
    if (!t.gpsMarker) return;
    t.gpsMarker.remove();
    t.gpsMarker = null;
    if (t === active) syncExifChip();
}

document.addEventListener('click', e => {
    const btn = e.target.closest('[data-action="remove-gps"]');
    if (!btn) return;
    const t = tabs.find(t => String(t.id) === btn.dataset.tab);
    if (t) removeExifGps(t);
});

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
    if (exifGps(t.exif)) { $('exif-card').style.display = 'none'; toggleExifGps(t); }
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
    cancelCalc(t);
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
    cancelCalc(t);
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
$('btn-demo').addEventListener('click', loadDemo);

// The photo area without a photo: the drop prompt, or, for a restored session, the photo it waits for.
function updateDropOverlay() {
    const t = active;
    overlay.innerHTML = t.pendingImage
        ? `<span class="drop-restored-title">Session restored</span>` +
          `<span class="drop-restore">drop <b>${escHtml(t.pendingImage)}</b> to see the photo again</span>` +
          `<button id="btn-browse" type="button">Browse</button>` +
          `<span class="drop-note">The points and the time are kept; the band is already on the map.</span>`
        : `<span class="drop-title">Drop / Paste image here</span>` +
          `<button id="btn-browse" type="button">Browse</button>` +
          `<span class="drop-or">or</span>` +
          `<button id="btn-demo-link" type="button">Try the Demo</button>` +
          `<span class="drop-note">No photo? Type the height and shadow length above.</span>`;
}
overlay.addEventListener('click', e => {
    if (e.target.id === 'btn-browse') $('file-picker').click();
    else if (e.target.id === 'btn-demo-link') loadDemo();
});

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
// being dragged) does not pulse the band. Once the input is incomplete or invalid, the band it
// had goes (and a calculation still running for the old input is dropped), so the map never
// shows a band for values that are no longer in the fields.
function onInputChanged(t, { delay = 350, quiet = false } = {}) {
    const complete = !!getMeasurements(t) && dtEpoch(t) != null;
    if (!complete) {
        const wasBusy = t.busy;
        cancelCalc(t);
        if (t.result || t.noMatch || wasBusy) {
            t.result = null; t.noMatch = false;
            syncObservations();
            renderBands();
            refreshPinPopup();
            renderTabs();
        }
    }
    if (t === active) { updateMeasureUI(); updateGuide(); }
    scheduleAutosave();
    clearTimeout(t.timer);
    if (!complete) return;
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
            else if (!quiet) pulseBand(t);
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

// The sun at one moment, by the formulas of SunCalc (github.com/mourner/suncalc, BSD-2-Clause;
// the JS twin of the original ShadowFinder's suncalc package), split into the
// part that depends only on the time and the part that depends on the place:
//   sin(altitude) = sin(lat)·sinDec + cos(lat)·cosDec·cos(theta + lng)
// theta is the sun's hour angle at longitude 0 (radians); the sun is overhead at lat = dec,
// lng = -theta.
const D2R = Math.PI / 180;
function sunAt(ms) {
    const d = ms / 86400000 - 0.5 + 2440588 - 2451545;   // days since J2000.0
    const M = D2R * (357.5291 + 0.98560028 * d);          // mean anomaly
    const C = D2R * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const L = M + C + D2R * 102.9372 + Math.PI;           // ecliptic longitude
    const e = D2R * 23.4397;                              // obliquity of the ecliptic
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));
    const theta = D2R * (280.16 + 360.9856235 * d) - ra;  // sidereal time at Greenwich − RA
    return { dec, theta, sinDec: Math.sin(dec), cosDec: Math.cos(dec) };
}
const sinSunAlt = (sun, lat, lng) =>
    Math.sin(lat * D2R) * sun.sinDec + Math.cos(lat * D2R) * sun.cosDec * Math.cos(sun.theta + lng * D2R);

function findShadows(baseEpochMs, objectHeight, shadowLength, mode, tzGrid) {
    // Layout (GRID, MATCH_TOL) is shared with contours.js, which outlines the band.
    const { rows, cols } = GRID;
    const offsetMap = mode === 'local' ? tzGrid?._offsetMap : null;

    const sinLat = new Float64Array(rows), cosLat = new Float64Array(rows);
    for (let i = 0; i < rows; i++) {
        const lat = (GRID.minLat + i * GRID.res) * D2R;
        sinLat[i] = Math.sin(lat); cosLat[i] = Math.cos(lat);
    }
    // The sun and cos(hour angle) per column, once per clock offset: one in UTC mode, one per
    // distinct zone offset in Local mode. Everything else per cell is a multiply-add.
    const bySun = new Map();
    const sunFor = offsetMin => {
        let s = bySun.get(offsetMin);
        if (!s) {
            const sun = sunAt(baseEpochMs - offsetMin * 60000);
            const cosH = new Float64Array(cols);
            for (let j = 0; j < cols; j++) cosH[j] = Math.cos(sun.theta + (GRID.minLon + j * GRID.res) * D2R);
            s = { sinDec: sun.sinDec, cosDec: sun.cosDec, cosH };
            bySun.set(offsetMin, s);
        }
        return s;
    };
    const utcSun = sunFor(0);

    // grid holds the relative shadow-length error per cell, continuous so the band edge can be
    // interpolated between cells (Infinity = sun below the horizon). A cell is in the band
    // when its error is below MATCH_TOL. One grid per observation.
    const grid = new Float32Array(rows * cols).fill(Infinity);
    let count = 0;

    for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
            const idx = i * cols + j;
            const s = offsetMap ? sunFor(offsetMap.get(tzGrid.timezones[idx]) ?? 0) : utcSun;
            const sinAlt = sinLat[i] * s.sinDec + cosLat[i] * s.cosDec * s.cosH[j];
            if (sinAlt <= 0) continue;   // sun at or below the horizon

            // shadow = height / tan(altitude) = height · cos / sin
            const calcShadow = objectHeight * Math.sqrt(Math.max(0, 1 - sinAlt * sinAlt)) / sinAlt;
            const diff = Math.abs(calcShadow - shadowLength) / shadowLength;
            grid[idx] = diff;
            if (diff < MATCH_TOL) count++;
        }
    }

    return { grid, count };
}

// ---- RENDER: BANDS AND DAYLIGHT ----

// Bands and the daylight wash are painted into images pinned to lat/lon boxes, which MapLibre
// drapes over the globe (or flat map) like any other layer. MapLibre stretches an image evenly
// in Web Mercator between its corners, so image rows are spaced in Mercator y.
const DAY_LAYER = 'daylight';
const MERC_MAX_LAT = 85.05112878;
const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
const latOfMercY = y => Math.atan(Math.sinh(y)) * 180 / Math.PI;

const BAND_IMG_W  = 1440;   // 2 px per 0.5° grid column
const BAND_MERC_TOP = mercY(GRID.maxLat), BAND_MERC_BOT = mercY(GRID.minLat);
const BAND_IMG_H  = Math.round((BAND_MERC_TOP - BAND_MERC_BOT) / (2 * Math.PI) * BAND_IMG_W);

// Grid row / column nearest to a latitude / longitude. A grid value was sampled exactly at its
// coordinate, so it is drawn centred there (as the GeoJSON outline and the pin read it), not over
// the cell north-east of it. Longitude wraps: +180 is column 0 again.
const nearestRow = lat => Math.min(GRID.rows - 1, Math.max(0, Math.round((lat - GRID.minLat) / GRID.res)));
const nearestCol = lon => ((Math.round((lon - GRID.minLon) / GRID.res) % GRID.cols) + GRID.cols) % GRID.cols;

// Grid row / column for each image row / column.
const BAND_ROW_GI = new Int32Array(BAND_IMG_H);
for (let py = 0; py < BAND_IMG_H; py++) {
    BAND_ROW_GI[py] = nearestRow(latOfMercY(BAND_MERC_TOP - (py + 0.5) / BAND_IMG_H * (BAND_MERC_TOP - BAND_MERC_BOT)));
}
const BAND_COL_GJ = new Int32Array(BAND_IMG_W);
for (let px = 0; px < BAND_IMG_W; px++) {
    BAND_COL_GJ[px] = nearestCol(GRID.minLon + (px + 0.5) / BAND_IMG_W * (GRID.maxLon - GRID.minLon));
}

// ---- Layers on the map ----
// Every shadow's band is a layer of its own, the overlap of all bands (in Overlap mode) one more
// on top, and the daylight wash of the selected shadow's moment underneath. Each has its own
// opacity (the Layers dropdown in the map bar); an image is repainted only when its result changes.

const BAND_COORDS = [[GRID.minLon, GRID.maxLat], [GRID.maxLon, GRID.maxLat], [GRID.maxLon, GRID.minLat], [GRID.minLon, GRID.minLat]];
const DAY_COORDS  = [[-180, MERC_MAX_LAT], [180, MERC_MAX_LAT], [180, -MERC_MAX_LAT], [-180, -MERC_MAX_LAT]];
const OVERLAP_LAYER = 'overlap';
const bandLayerId = t => `band-${t.id}`;

// Opacity of each layer: what the user set, or a default (null). A band on its own is at 85%;
// once the overlap is shown, the single bands step back to 25% so the overlap stands out.
const layerOpacity = { overlap: null, daylight: null };
const overlapShown = () => showMode === 'all' && observations.length >= 2;
// (a single band next to the overlap needs more opacity on a light map or imagery than on the dark map)
const bandOpacity    = t => t.opacity ?? (overlapShown() ? palette.besideOverlap : 0.85);
const overlapOpacity = () => layerOpacity.overlap ?? 0.85;
const dayOpacity     = () => layerOpacity.daylight ?? 0.85;

// ---- Colours per base map ----
// Amber reads well on the dark map but sinks into a light map or into desert imagery, and a
// faint golden "day" wash vanishes on a near-white map. So each base map has its own palette:
// the band's colour from an exact match (t = 0) to the 20% edge (t = 1), and a day/night shade,
// either brightening the daylit side (dark map) or darkening the night side (light and imagery).
const mixRgb = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const PALETTES = {
    'dark':     { band: t => [255, 179 * (1 - t), 0, 220 * (1 - t)],                          besideOverlap: 0.25, shade: { day: true,  rgb: [255, 179, 0], a: 21 } },
    'osm':      { band: t => [...mixRgb([214, 58, 0], [150, 0, 70], t), 230 * (1 - t)],       besideOverlap: 0.4,  shade: { day: false, rgb: [20, 30, 70],  a: 50 } },
    'esri-sat': { band: t => [...mixRgb([255, 40, 220], [120, 70, 255], t), 230 * (1 - t)],   besideOverlap: 0.45, shade: { day: false, rgb: [0, 4, 28],    a: 95 } },
};
let paletteId = '', palette = null, bandLut = null;
function setPalette(id) {
    paletteId = PALETTES[id] ? id : 'dark';
    palette = PALETTES[paletteId];
    bandLut = new Uint8ClampedArray(256 * 4);   // the band colour for 256 steps of t
    for (let k = 0; k < 256; k++) bandLut.set(palette.band(k / 255).map(Math.round), k * 4);
}
setPalette(prefs.get('sf-tileset') || 'dark');
const shadeName = () => palette.shade.day ? 'Daylight' : 'Night';

// One band pixel at match error fraction t (0 exact … 1 the tolerance edge).
function putBand(d, o, t) {
    const q = ((t <= 0 ? 0 : t >= 1 ? 1 : t) * 255 | 0) * 4;
    d[o] = bandLut[q]; d[o+1] = bandLut[q+1]; d[o+2] = bandLut[q+2]; d[o+3] = bandLut[q+3];
}
// One day/night pixel, k = how far the sun is up (0 night … 1 day, soft across the terminator).
function putShade(d, o, k) {
    const s = palette.shade, w = s.day ? k : 1 - k;
    if (w <= 0) return;
    d[o] = s.rgb[0]; d[o+1] = s.rgb[1]; d[o+2] = s.rgb[2]; d[o+3] = (s.a * w) | 0;
}

// A new base map brings its colours: every band, the overlap and the shade are repainted.
function applyPalette(id) {
    if (id === paletteId) return;
    setPalette(id);
    tabs.forEach(t => { t.bandImgFor = null; });
    overlapImgFor = '';
    dayImgFor = null;
    renderBands();
}

// One band: bright where the shadow matches exactly, fading toward the 20% tolerance edge.
function paintBandImage(grids) {
    const img = new ImageData(BAND_IMG_W, BAND_IMG_H);
    const d = img.data;
    const n = grids.length;
    for (let py = 0; py < BAND_IMG_H; py++) {
        const base = BAND_ROW_GI[py] * GRID.cols;
        for (let px = 0; px < BAND_IMG_W; px++) {
            const idx = base + BAND_COL_GJ[px];
            // the overlap (n > 1) is where every band matches, graded by their mean error
            let sum = 0, all = true;
            for (let k = 0; k < n; k++) {
                const dff = grids[k][idx];
                if (!(dff < MATCH_TOL)) { all = false; break; }
                sum += dff;
            }
            if (!all) continue;
            putBand(d, (py * BAND_IMG_W + px) * 4, (sum / n) / MATCH_TOL);
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
    const sun = sunAt(epochMs);
    const NLAT = 181, NLON = 361;   // 1° samples, -90..90 × -180..180
    const alt = new Float32Array(NLAT * NLON);
    for (let a = 0; a < NLAT; a++) {
        for (let o = 0; o < NLON; o++) {
            alt[a * NLON + o] = Math.asin(sinSunAlt(sun, a - 90, o - 180)) / D2R;
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
            putShade(d, (py * DAY_IMG_W + px) * 4, Math.min(1, Math.max(0, v + 0.5)));
        }
    }
    return img;
}

// Adds or updates an image layer. New layers go below `beforeId` when that exists.
function setImageLayer(id, coords, image, beforeId, resampling = 'nearest') {
    const src = map.getSource(id);
    if (src) {
        src.updateImage({ image });
    } else {
        map.addSource(id, { type: 'image', coordinates: coords });
        map.getSource(id).updateImage({ image });
        map.addLayer({
            id, type: 'raster', source: id,
            paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0, 'raster-resampling': resampling },
        }, beforeId && map.getLayer(beforeId) ? beforeId : undefined);
    }
}
const showLayer = (id, on) => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); };
const setOpacity = (id, v) => { if (map.getLayer(id)) map.setPaintProperty(id, 'raster-opacity', v); };
const removeImageLayer = id => { if (map.getLayer(id)) map.removeLayer(id); if (map.getSource(id)) map.removeSource(id); };

// The lowest of the result layers, for a new layer that has to go underneath them all.
function firstResultLayer() {
    return map.getStyle().layers.map(l => l.id).find(id => id.startsWith('band-') || id === OVERLAP_LAYER);
}

let overlapImgFor = '';
async function renderBands() {
    $('show-toggle').hidden = observations.length < 2;
    syncShowToggle();
    syncMapBarButtons();
    await mapReady;

    // bands of shadows that no longer exist go
    map.getStyle().layers.map(l => l.id).filter(id => /^band-\d+$/.test(id))
        .forEach(id => { if (!tabs.some(t => t.result && bandLayerId(t) === id)) removeImageLayer(id); });

    // one layer per shadow with a result, below the overlap
    for (const t of tabs) {
        if (!t.result) continue;
        const id = bandLayerId(t);
        if (t.bandImgFor !== t.result || !map.getLayer(id)) {
            setImageLayer(id, BAND_COORDS, paintBandImage([t.result.grid]), map.getLayer(OVERLAP_LAYER) ? OVERLAP_LAYER : undefined);
            t.bandImgFor = t.result;
        }
        showLayer(id, showMode === 'all' || t === active);
        setOpacity(id, bandOpacity(t));
    }

    // the overlap of all bands
    if (overlapShown()) {
        const key = observations.map(o => `${o.id}:${o.baseEpochMs}:${o.mode}:${o.h}:${o.s}`).join('|');
        if (key !== overlapImgFor || !map.getLayer(OVERLAP_LAYER)) {
            setImageLayer(OVERLAP_LAYER, BAND_COORDS, paintBandImage(observations.map(o => o.grid)));
            overlapImgFor = key;
        }
        showLayer(OVERLAP_LAYER, true);
        setOpacity(OVERLAP_LAYER, overlapOpacity());
    } else {
        showLayer(OVERLAP_LAYER, false);
    }

    // daylight of the selected shadow's moment (only a UTC time is one moment for the whole Earth);
    // before there is any band, the day and night of this moment, to the minute
    const day = dayObservation();
    const dayMs = day ? day.baseEpochMs : !observations.length ? Math.floor(Date.now() / 60000) * 60000 : null;
    if (dayMs != null) {
        if (dayImgFor !== dayMs || !map.getLayer(DAY_LAYER)) {
            setImageLayer(DAY_LAYER, DAY_COORDS, paintDaylightImage(dayMs), firstResultLayer(), 'linear');
            dayImgFor = dayMs;
        }
        showLayer(DAY_LAYER, true);
        setOpacity(DAY_LAYER, dayOpacity());
    } else {
        showLayer(DAY_LAYER, false);
    }
    if ($('layers-card').style.display !== 'none') renderLayersCard();
}

function dayObservation() {
    const r = active.result || (observations.length === 1 ? observations[0] : null);
    return r && r.mode === 'utc' ? r : null;
}

// A short glow on a band (or the overlap), to show it was updated without moving the map.
let pulseRaf = 0;
function pulseBand(t) {
    const id = overlapShown() ? OVERLAP_LAYER : bandLayerId(t);
    if (!map.getLayer(id)) return;
    const base = id === OVERLAP_LAYER ? overlapOpacity() : bandOpacity(t);
    cancelAnimationFrame(pulseRaf);
    const t0 = performance.now(), dur = 650;
    const step = now => {
        if (!map.getLayer(id)) return;   // its shadow was closed mid-pulse
        const k = Math.sin(Math.min(1, (now - t0) / dur) * Math.PI);
        map.setPaintProperty(id, 'raster-opacity', base + (1 - base) * k);
        map.setPaintProperty(id, 'raster-brightness-min', 0.35 * k);
        if (now - t0 < dur) pulseRaf = requestAnimationFrame(step);
        else { map.setPaintProperty(id, 'raster-opacity', base); map.setPaintProperty(id, 'raster-brightness-min', 0); }
    };
    pulseRaf = requestAnimationFrame(step);
}

// ---- LAYERS DROPDOWN (map bar): an opacity slider per band, the overlap and the daylight ----

function renderLayersCard() {
    const card = $('layers-card');
    card.innerHTML = '<div class="panel-title">Opacity</div>';
    const row = (label, value, enabled, onInput, onReset, title) => {
        const r = document.createElement('div');
        r.className = 'adjust-row' + (enabled ? '' : ' disabled');
        if (title) r.title = title;
        const pct = Math.round(value * 100);
        r.innerHTML = `<label>${label}</label><input type="range" min="0" max="100" step="5" value="${pct}" ${enabled ? '' : 'disabled'}><span class="adjust-val">${pct}%</span>`;
        const input = r.querySelector('input'), val = r.querySelector('.adjust-val');
        input.addEventListener('input', () => { val.textContent = input.value + '%'; onInput(input.value / 100); });
        input.addEventListener('dblclick', () => { onReset(); renderLayersCard(); });
        card.appendChild(r);
    };
    tabs.forEach(t => {
        if (!t.result) return;
        row(`Shadow ${tabIndex(t)}`, bandOpacity(t), showMode === 'all' || t === active,
            v => { t.opacity = v; setOpacity(bandLayerId(t), v); scheduleAutosave(); },
            () => { t.opacity = null; renderBands(); },
            showMode === 'all' || t === active ? 'Double-click to reset' : 'Hidden while only the selected shadow is shown');
    });
    if (observations.length >= 2) {
        row('Overlap', overlapOpacity(), overlapShown(),
            v => { layerOpacity.overlap = v; setOpacity(OVERLAP_LAYER, v); },
            () => { layerOpacity.overlap = null; renderBands(); },
            overlapShown() ? 'Where every band matches. Double-click to reset' : 'Shown in Overlap mode');
    }
    const day = dayObservation();
    row(shadeName(), dayOpacity(), !!day,
        v => { layerOpacity.daylight = v; setOpacity(DAY_LAYER, v); },
        () => { layerOpacity.daylight = null; renderBands(); },
        day ? `${palette.shade.day ? 'Where the sun was up' : 'Where the sun was down'} at that moment. Double-click to reset` : 'Shown for a UTC time');
    const foot = document.createElement('div');
    foot.className = 'adjust-foot';
    foot.innerHTML = '<span>Double-click a slider to reset it</span><button type="button">Reset all</button>';
    foot.querySelector('button').addEventListener('click', () => {
        tabs.forEach(t => { t.opacity = null; });
        layerOpacity.overlap = layerOpacity.daylight = null;
        renderBands();
        scheduleAutosave();
    });
    card.appendChild(foot);
}

$('btn-layers').addEventListener('click', e => {
    e.stopPropagation();
    const card = $('layers-card');
    const open = card.style.display === 'none';
    if (open) renderLayersCard();
    card.style.display = open ? 'block' : 'none';
    $('btn-layers').setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', e => { if (!$('layers-wrap').contains(e.target)) $('layers-card').style.display = 'none'; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('layers-card').style.display = 'none'; });

// ---- CENTRE ON THE RING (map bar) ----
// A UTC band is a ring around the point where the sun stood straight overhead; this turns the map
// there. A Local band has no single such point (every place has its own clock), so it stays off.

// The subsolar point, from the same sun model as the bands, so it is the exact centre of the ring.
function subsolarPoint(ms) {
    const sun = sunAt(ms);
    return { lat: sun.dec / D2R, lng: ((-sun.theta / D2R) % 360 + 540) % 360 - 180 };
}

function syncMapBarButtons() {
    const r = active.result;
    const btn = $('btn-center');
    btn.disabled = !(r && r.mode === 'utc');
    btn.title = !r ? 'Centre the map on the ring (once there is a band)'
              : r.mode === 'utc' ? 'Centre the map on the ring: where the sun stood straight overhead'
              : 'Only for UTC times: a Local band is not a single ring';
    $('btn-layers').disabled = !observations.length;
    $('btn-export').disabled = !observations.length;
}

$('btn-center').addEventListener('click', () => {
    const r = active.result;
    if (!r || r.mode !== 'utc') return;
    const s = subsolarPoint(r.baseEpochMs);
    map.flyTo({ center: [s.lng, s.lat], zoom: frameZoom(), bearing: 0, pitch: 0 });
});

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
    scheduleAutosave();
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
// For the selected shadow: how high the sun stood (from the height / shadow ratio) and the ring's
// radius, the distance from the point where the sun was straight overhead to the band.

function updateSunReadout() {
    const el = $('sun-readout');
    const r = active.result;
    if (!r) { el.hidden = true; return; }
    const alt = Math.atan2(r.h, r.s) * RAD;
    const radiusKm = Math.round((90 - alt) * 111.2 / 10) * 10;   // 1° of arc ≈ 111.2 km
    const parts = [
        ['Sun elevation', `${alt.toFixed(1)}°`, 'How high the sun stood above the horizon, from the height / shadow ratio'],
        ['Ring radius', `${radiusKm.toLocaleString('en')} km`, 'Distance from the point where the sun stood straight overhead to the band'],
    ];
    el.innerHTML = parts.map(([k, v, t]) => `<span title="${t}"><i>${k}</i><b>${v}</b></span>`).join('');
    el.hidden = false;
}

let coordPin = null;

// Which shadows' bands cover a spot (nearest grid cell), as text for the pin.
function bandsAt(lat, lng) {
    if (lat < GRID.minLat || lat > GRID.maxLat) return 'Outside the calculated area (60°S to 85°N)';
    const idx = nearestRow(lat) * GRID.cols + nearestCol(lng);
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

// ---- MAP RIGHT-CLICK: copy the coordinates, open the spot in other maps or in TracePoint ----
// After TracePoint's map menu. MapLibre fires 'contextmenu' only for a right-click without a drag
// (right-drag rotates). The links are plain hrefs: nothing is requested until one is clicked.

// The other services count zoom in 256 px tiles, MapLibre in 512 px: one level apart.
const CTX_LINKS = [
    ['Google Maps',   (la, ln, z) => `https://www.google.com/maps/search/?api=1&query=${la},${ln}`],
    ['Street View',   (la, ln, z) => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${la},${ln}`],
    ['Google Earth',  (la, ln, z) => `https://earth.google.com/web/@${la},${ln},0a,2000d,35y,0h,0t,0r`],
    ['OpenStreetMap', (la, ln, z) => `https://www.openstreetmap.org/?mlat=${la}&mlon=${ln}#map=${z}/${la}/${ln}`],
];
const CTX_MORE_LINKS = [
    ['Apple Maps',  (la, ln, z) => `https://maps.apple.com/?ll=${la},${ln}&q=${la},${ln}&z=${z}`],
    ['Lookmap',     (la, ln, z) => `https://lookmap.skzk.dev/#c=${z - 1}/${la}/${ln}`],
    ['Bing Maps',   (la, ln, z) => `https://www.bing.com/maps?cp=${la}~${ln}&lvl=${z}&sp=point.${la}_${ln}_Pin`],
    ['Mapillary',   (la, ln, z) => `https://www.mapillary.com/app/?lat=${la}&lng=${ln}&z=${z - 1}`],
    ['Yandex Maps', (la, ln, z) => `https://yandex.com/maps/?ll=${ln},${la}&z=${z}&pt=${ln},${la}`],
];
// TracePoint, the sibling tool, opens a view from its URL hash (#lat,lng,zoom in MapLibre zoom).
// A shadow band narrows a search to a region; TracePoint pins the camera down inside it.
const TRACEPOINT_URL = 'https://kluter.github.io/TracePoint/';
const tracepointLink = (la, ln) => `${TRACEPOINT_URL}#${la},${ln},${Math.max(14, Math.round(map.getZoom())).toFixed(2)}`;

const ctxMenu = document.createElement('div');
ctxMenu.className = 'map-ctx-menu';
ctxMenu.style.display = 'none';
$('map-container').appendChild(ctxMenu);
// The submenu is an element of its own next to the menu (the menu clips what it contains)
const ctxSub = document.createElement('div');
ctxSub.className = 'map-ctx-menu map-ctx-sub';
ctxSub.style.display = 'none';
$('map-container').appendChild(ctxSub);
let ctxSubTimer = 0;

function hideCtxSub()  { clearTimeout(ctxSubTimer); ctxSub.style.display = 'none'; }
function hideCtxMenu() { ctxMenu.style.display = 'none'; hideCtxSub(); }
// Right of the menu, level with its "Open in…" row; left of it where the map ends
function showCtxSub(trigger) {
    clearTimeout(ctxSubTimer);
    const box = map.getContainer().getBoundingClientRect();
    const m = ctxMenu.getBoundingClientRect(), t = trigger.getBoundingClientRect();
    ctxSub.style.display = 'block';
    const w = ctxSub.offsetWidth, h = ctxSub.offsetHeight;
    const left = m.right - box.left + w > box.width ? m.left - box.left - w + 1 : m.right - box.left - 1;
    ctxSub.style.left = `${Math.max(0, left)}px`;
    ctxSub.style.top  = `${Math.max(0, Math.min(t.top - box.top, box.height - h))}px`;
}
// Leaving towards the submenu must not close it on the way
function leaveCtxSub() { clearTimeout(ctxSubTimer); ctxSubTimer = setTimeout(hideCtxSub, 250); }
ctxSub.addEventListener('mouseenter', () => clearTimeout(ctxSubTimer));
ctxSub.addEventListener('mouseleave', leaveCtxSub);

map.on('contextmenu', e => {
    e.preventDefault();
    const la = e.lngLat.lat.toFixed(6);
    const ln = e.lngLat.lng.toFixed(6);
    const z  = Math.round(map.getZoom()) + 1;
    const add = (parent, tag, cls, text) => {
        const n = document.createElement(tag);
        n.className = cls;
        if (text) n.textContent = text;
        parent.appendChild(n);
        return n;
    };
    const link = (parent, text, href) => {
        const a = add(parent, 'a', 'map-ctx-item', text);
        a.href = href; a.target = '_blank'; a.rel = 'noopener';
        a.addEventListener('click', hideCtxMenu);
        return a;
    };

    ctxMenu.innerHTML = '';
    add(ctxMenu, 'div', 'map-ctx-head', `${la}, ${ln}`);
    const copy = add(ctxMenu, 'button', 'map-ctx-item', 'Copy coordinates');
    copy.type = 'button';
    copy.addEventListener('click', () => {
        hideCtxMenu();
        navigator.clipboard.writeText(`${la}, ${ln}`)
            .then(() => showToast('Coordinates copied.', 'success'))
            .catch(() => showToast('Could not copy to clipboard.'));
    });
    const tp = link(ctxMenu, 'Open in TracePoint', tracepointLink(la, ln));
    tp.classList.add('map-ctx-tracepoint');
    tp.title = 'Pin the camera position down with lines of sight, in the companion tool';
    tp.addEventListener('mouseenter', leaveCtxSub);

    add(ctxMenu, 'div', 'map-ctx-divider');
    CTX_LINKS.forEach(([label, url]) => link(ctxMenu, `Open in ${label}`, url(la, ln, z)).addEventListener('mouseenter', leaveCtxSub));

    const more = add(ctxMenu, 'button', 'map-ctx-item map-ctx-more', 'Open in…');
    more.type = 'button';
    more.setAttribute('aria-haspopup', 'true');
    more.addEventListener('mouseenter', () => showCtxSub(more));
    more.addEventListener('mouseleave', leaveCtxSub);
    more.addEventListener('click', () => { if (ctxSub.style.display === 'none') showCtxSub(more); else hideCtxSub(); });
    hideCtxSub();
    ctxSub.innerHTML = '';
    CTX_MORE_LINKS.forEach(([label, url]) => link(ctxSub, label, url(la, ln, z)));

    // at the click, flipped so it stays inside the map
    const box = map.getContainer().getBoundingClientRect();
    ctxMenu.style.display = 'block';
    const w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
    const x = e.point.x + w > box.width  ? e.point.x - w : e.point.x;
    const y = e.point.y + h > box.height ? e.point.y - h : e.point.y;
    ctxMenu.style.left = `${Math.max(0, x)}px`;
    ctxMenu.style.top  = `${Math.max(0, y)}px`;
});
map.on('movestart', hideCtxMenu);
map.on('click', hideCtxMenu);
document.addEventListener('mousedown', e => { if (!ctxMenu.contains(e.target) && !ctxSub.contains(e.target)) hideCtxMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideCtxMenu(); });

// ---- EXPORT: the bands for Google Earth (KMZ) and GIS (GeoTIFF, GeoJSON) ----
// KMZ and GeoTIFF carry the bands as they look, painted straight from the 0.5° grid in plain
// latitude / longitude (equirectangular, what both formats expect); GeoJSON carries their outlines
// (contours.js). All three are written here, no library: a KMZ is a zip of doc.kml and PNGs, the
// GeoTIFF an uncompressed RGBA TIFF with the GeoTIFF tags for EPSG:4326.

const EQ_SCALE = 2;                                  // image pixels per grid cell
const EQ_W = GRID.cols * EQ_SCALE, EQ_H = GRID.rows * EQ_SCALE;
const EQ_NORTH = GRID.minLat + GRID.rows * GRID.res; // 85
const EQ_SOUTH = GRID.minLat;                        // -60

// Grid row / column for each export pixel: the nearest sample, as on the map.
const EQ_ROW_GI = Int32Array.from({ length: EQ_H }, (_, py) => nearestRow(EQ_NORTH - (py + 0.5) * GRID.res / EQ_SCALE));
const EQ_COL_GJ = Int32Array.from({ length: EQ_W }, (_, px) => nearestCol(GRID.minLon + (px + 0.5) * GRID.res / EQ_SCALE));

// A band (one grid) or the overlap (several), north up, in the map's colours.
function paintEquirect(grids) {
    const img = new ImageData(EQ_W, EQ_H);
    const d = img.data, n = grids.length;
    for (let py = 0; py < EQ_H; py++) {
        const base = EQ_ROW_GI[py] * GRID.cols;
        for (let px = 0; px < EQ_W; px++) {
            const idx = base + EQ_COL_GJ[px];
            let sum = 0, all = true;
            for (let k = 0; k < n; k++) {
                const v = grids[k][idx];
                if (!(v < MATCH_TOL)) { all = false; break; }
                sum += v;
            }
            if (!all) continue;
            putBand(d, (py * EQ_W + px) * 4, (sum / n) / MATCH_TOL);
        }
    }
    return img;
}

// The daylight of one UTC moment over the whole Earth, 0.5° per pixel.
function paintDaylightEquirect(ms) {
    const W = 720, H = 360, img = new ImageData(W, H), d = img.data, sun = sunAt(ms);
    for (let py = 0; py < H; py++) {
        const lat = 90 - (py + 0.5) * 0.5;
        for (let px = 0; px < W; px++) {
            const alt = Math.asin(sinSunAlt(sun, lat, -180 + (px + 0.5) * 0.5)) / D2R;
            putShade(d, (py * W + px) * 4, Math.min(1, Math.max(0, alt + 0.5)));
        }
    }
    return img;
}

// Layers over each other with their opacities ("over" compositing), as the map shows them.
function composite(layers) {
    const out = new ImageData(EQ_W, EQ_H), o = out.data;
    for (const { img, opacity } of layers) {
        const s = img.data;
        for (let p = 0; p < s.length; p += 4) {
            const a = s[p+3] / 255 * opacity;
            if (!a) continue;
            const b = o[p+3] / 255, outA = a + b * (1 - a);
            for (let c = 0; c < 3; c++) o[p+c] = Math.round((s[p+c] * a + o[p+c] * b * (1 - a)) / outA);
            o[p+3] = Math.round(outA * 255);
        }
    }
    return out;
}

// The layers to export, as on the map: each shadow's band, the overlap (Overlap mode, 2+ bands)
// and the daylight of the selected shadow (UTC only).
function exportLayers() {
    const list = [];
    tabs.forEach(t => {
        if (!t.result) return;
        list.push({ key: `shadow-${tabIndex(t)}`, name: `Shadow ${tabIndex(t)} · ${t.result.label}`,
            grids: [t.result.grid], opacity: bandOpacity(t), visible: showMode === 'all' || t === active });
    });
    if (observations.length >= 2) {
        list.push({ key: 'overlap', name: 'Overlap of all bands', grids: observations.map(o => o.grid),
            opacity: overlapOpacity(), visible: overlapShown() });
    }
    return list;
}

const imageDataToPng = img => new Promise((resolve, reject) => {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').putImageData(img, 0, 0);
    c.toBlob(b => b ? resolve(b) : reject(new Error('PNG')), 'image/png');
});

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---- ZIP (stored, no compression: PNGs are compressed already) ----
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
})();
function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}
// DOS date of every entry: 1980-01-01, the earliest valid one (0 is not a date, some tools object)
const ZIP_DATE = (0 << 9) | (1 << 5) | 1;
function makeZip(files) {   // files: [{ name, data: Uint8Array }]
    const enc = new TextEncoder(), parts = [], central = [];
    let offset = 0;
    for (const f of files) {
        const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
        const h = new DataView(new ArrayBuffer(30));
        h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);   // UTF-8 names
        h.setUint16(8, 0, true); h.setUint16(12, ZIP_DATE, true); h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true);
        h.setUint16(26, name.length, true);
        parts.push(new Uint8Array(h.buffer), name, f.data);
        const c = new DataView(new ArrayBuffer(46));
        c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
        c.setUint16(14, ZIP_DATE, true); c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true);
        c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
        central.push(new Uint8Array(c.buffer), name);
        offset += 30 + name.length + size;
    }
    const cdSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/vnd.google-earth.kmz' });
}

// ---- KMZ: one image overlay per band, the overlap and the daylight, each with its opacity ----
async function exportKmz() {
    const layers = exportLayers();
    if (!layers.length) return showToast('No band to export yet.');
    const files = [], overlays = [];
    const kmlAlpha = v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0') + 'ffffff';
    const box = (n, s) => `<LatLonBox><north>${n}</north><south>${s}</south><east>180</east><west>-180</west></LatLonBox>`;
    for (const l of layers) {
        const png = new Uint8Array(await (await imageDataToPng(paintEquirect(l.grids))).arrayBuffer());
        files.push({ name: `files/${l.key}.png`, data: png });
        overlays.push(`<GroundOverlay><name>${escHtml(l.name)}</name><visibility>${l.visible ? 1 : 0}</visibility>` +
            `<color>${kmlAlpha(l.opacity)}</color><Icon><href>files/${l.key}.png</href></Icon>${box(EQ_NORTH, EQ_SOUTH)}</GroundOverlay>`);
    }
    const day = dayObservation();
    if (day) {
        const png = new Uint8Array(await (await imageDataToPng(paintDaylightEquirect(day.baseEpochMs))).arrayBuffer());
        files.push({ name: 'files/daylight.png', data: png });
        overlays.push(`<GroundOverlay><name>${shadeName()} · ${escHtml(day.label)}</name><visibility>1</visibility>` +
            `<color>${kmlAlpha(dayOpacity())}</color><drawOrder>-1</drawOrder><Icon><href>files/daylight.png</href></Icon>${box(90, -90)}</GroundOverlay>`);
    }
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<name>ShadowFinder Web · shadow bands</name>
<description>Where each shadow could fall at its capture time (sun-elevation match within ${Math.round(MATCH_TOL * 100)}%), 0.5° grid, 60°S to 85°N. Made with ShadowFinder Web, a browser port of Bellingcat's ShadowFinder.</description>
${overlays.join('\n')}
</Document></kml>`;
    files.unshift({ name: 'doc.kml', data: new TextEncoder().encode(kml) });
    downloadBlob(makeZip(files), `shadowfinder_bands_${exportStamp()}.kmz`);
    showToast('KMZ exported: open it in Google Earth.', 'success');
}

// ---- GeoTIFF: the bands as shown, composited, RGBA, EPSG:4326 ----
function makeGeoTiff(img, west, north, resDeg) {
    const W = img.width, H = img.height, pixels = img.data;
    // tag, type (3 SHORT, 4 LONG, 12 DOUBLE), values
    const entries = [
        [256, 4, [W]], [257, 4, [H]], [258, 3, [8, 8, 8, 8]], [259, 3, [1]], [262, 3, [2]],
        [273, 4, [0]],                     // StripOffsets, filled in below
        [277, 3, [4]], [278, 4, [H]], [279, 4, [pixels.length]], [284, 3, [1]],
        [338, 3, [2]],                     // ExtraSamples: unassociated alpha
        [339, 3, [1, 1, 1, 1]],
        [33550, 12, [resDeg, resDeg, 0]],                    // ModelPixelScale
        [33922, 12, [0, 0, 0, west, north, 0]],              // ModelTiepoint: pixel (0,0) → (west, north)
        [34735, 3, [1, 1, 0, 4,  1024, 0, 1, 2,  1025, 0, 1, 1,  2048, 0, 1, 4326,  2054, 0, 1, 9102]],   // GeoKeys: geographic, PixelIsArea, WGS 84, degrees
    ];
    const size = { 3: 2, 4: 4, 12: 8 };
    const ifdStart = 8, ifdSize = 2 + entries.length * 12 + 4;
    let extra = ifdStart + ifdSize;
    const extraOffsets = entries.map(([, type, vals]) => {
        const bytes = size[type] * vals.length;
        if (bytes <= 4) return null;
        const at = extra; extra += bytes + (bytes % 2);
        return at;
    });
    const dataStart = extra;
    entries.find(e => e[0] === 273)[2][0] = dataStart;
    const buf = new ArrayBuffer(dataStart + pixels.length), dv = new DataView(buf);
    dv.setUint16(0, 0x4949, true); dv.setUint16(2, 42, true); dv.setUint32(4, ifdStart, true);
    dv.setUint16(ifdStart, entries.length, true);
    const write = (at, type, vals) => vals.forEach((v, k) => {
        if (type === 3) dv.setUint16(at + k * 2, v, true);
        else if (type === 4) dv.setUint32(at + k * 4, v, true);
        else dv.setFloat64(at + k * 8, v, true);
    });
    entries.forEach(([tag, type, vals], i) => {
        const e = ifdStart + 2 + i * 12;
        dv.setUint16(e, tag, true); dv.setUint16(e + 2, type, true); dv.setUint32(e + 4, vals.length, true);
        if (extraOffsets[i] == null) write(e + 8, type, vals);
        else { dv.setUint32(e + 8, extraOffsets[i], true); write(extraOffsets[i], type, vals); }
    });
    dv.setUint32(ifdStart + 2 + entries.length * 12, 0, true);   // no next IFD
    new Uint8Array(buf, dataStart).set(pixels);
    return new Blob([buf], { type: 'image/tiff' });
}

function exportGeoTiff() {
    const layers = exportLayers().filter(l => l.visible);
    if (!layers.length) return showToast('No band to export yet.');
    const img = composite(layers.map(l => ({ img: paintEquirect(l.grids), opacity: l.opacity })));
    downloadBlob(makeGeoTiff(img, -180, EQ_NORTH, GRID.res / EQ_SCALE), `shadowfinder_bands_${exportStamp()}.tif`);
    showToast('GeoTIFF exported: the bands as shown, WGS 84 (EPSG:4326).', 'success');
}

// ---- GeoJSON: the outlines of each band and of the overlap ----
function exportGeoJson() {
    if (!observations.length) return showToast('No band to export yet.');
    const fc = bandsFeatureCollection(observations);
    // the observation features come in the order of `observations`, the tabs that have a band
    const withBand = tabs.filter(t => t.result);
    fc.features.forEach((f, k) => {
        if (f.properties.kind === 'observation' && withBand[k]) f.properties.shadow = `Shadow ${tabIndex(withBand[k])}`;
    });
    const blob = new Blob([JSON.stringify(fc)], { type: 'application/geo+json' });
    downloadBlob(blob, `shadowfinder_bands_${exportStamp()}.geojson`);
    showToast('GeoJSON exported: band outlines, WGS 84.', 'success');
}

function renderExportCard() {
    const card = $('export-card');
    card.innerHTML = '<div class="panel-title">Export the bands</div>';
    const entry = (label, ext, hint, run) => {
        const it = document.createElement('div');
        it.className = 'session-item export-item';
        it.innerHTML = `<span class="export-icon"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="1" x2="5" y2="8"/><polyline points="2,5.5 5,8.5 8,5.5"/></svg></span>` +
            `<span class="export-text"><b>${label}</b> <i>${ext}</i><small>${hint}</small></span>`;
        it.addEventListener('click', () => {
            card.style.display = 'none';
            setTimeout(() => run().catch?.(() => showToast('Export failed.')), 20);
        });
        card.appendChild(it);
    };
    entry('Google Earth', '.kmz', 'Each band, the overlap and the daylight as image overlays, as on the map', exportKmz);
    entry('GeoTIFF', '.tif', 'The bands as shown, one image for QGIS and other GIS', async () => exportGeoTiff());
    entry('GeoJSON', '.geojson', 'Outlines of each band and of the overlap', async () => exportGeoJson());
    const note = document.createElement('div');
    note.className = 'export-note';
    note.textContent = 'Covers 60°S to 85°N at 0.5°, the area the bands are calculated for. Opacity as set in Layers.';
    card.appendChild(note);
}

$('btn-export').addEventListener('click', e => {
    e.stopPropagation();
    const card = $('export-card');
    const open = card.style.display === 'none';
    if (open) renderExportCard();
    card.style.display = open ? 'block' : 'none';
    $('btn-export').setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', e => { if (!$('export-wrap').contains(e.target)) $('export-card').style.display = 'none'; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('export-card').style.display = 'none'; });

// ---- SESSION: import / export (photos optional) and autosave (as in TracePoint) ----
//
// A session file holds the shadows' inputs: points or typed height/length, capture time and zone,
// the photo's file name and the EXIF fields the app shows, photo adjustments and band opacity.
// Bands are recalculated on import, never stored. With "Include photos" each photo goes into the
// file unchanged (base64, EXIF and GPS included), so an import does not ask for it.
// The autosave keeps the same data in this browser (IndexedDB), photos as files next to it.

const SESSION_VERSION = 1;
const AUTOSAVE_KEY = 'sf-autosave', EXPORT_PHOTOS_KEY = 'sf-export-photos';
let autosaveOn = prefs.get(AUTOSAVE_KEY) !== '0';
let exportPhotos = prefs.get(EXPORT_PHOTOS_KEY) === '1';
let autosaveReady = false, autosaveOwner = false, autosaveTimer = 0, autosaveWarned = false;

const finite = v => typeof v === 'number' && Number.isFinite(v);

// Only the EXIF fields the app reads, as plain values (dates are already text).
const EXIF_KEYS = ['DateTimeOriginal', 'DateTimeDigitized', 'DateTime', 'OffsetTimeOriginal', 'OffsetTime',
    'OffsetTimeDigitized', 'Make', 'Model', 'LensModel', 'FocalLength', 'FNumber', 'ExposureTime', 'ISO',
    'ISOSpeedRatings', 'GPSLatitude', 'GPSLatitudeRef', 'GPSLongitude', 'GPSLongitudeRef'];
function exifToData(ex) {
    if (!ex) return null;
    const o = {};
    for (const k of EXIF_KEYS) {
        const v = ex[k];
        if (typeof v === 'string' || finite(v)) o[k] = v;
        else if (Array.isArray(v) && v.length <= 4 && v.every(finite)) o[k] = [...v];
    }
    return Object.keys(o).length ? o : null;
}
function exifFromData(o) {
    if (!o || typeof o !== 'object') return null;
    const ex = {};
    for (const k of EXIF_KEYS) {
        const v = o[k];
        if ((typeof v === 'string' && v.length < 200) || finite(v)) ex[k] = v;
        else if (Array.isArray(v) && v.length <= 4 && v.every(finite)) ex[k] = [...v];
    }
    return Object.keys(ex).length ? ex : null;
}

function tabToData(t) {
    return {
        name: `Shadow ${tabIndex(t)}`,
        imageFilename: t.fileName || t.pendingImage || null,
        points: t.points.map(p => ({ x: +p.x.toFixed(2), y: +p.y.toFixed(2) })),
        height: t.h, length: t.l,
        time: { ...t.dt }, mode: t.mode,
        exif: exifToData(t.exif),
        adjust: { ...t.adjust },
        opacity: t.opacity,
    };
}

const blobToDataURL = blob => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
});

async function tabToExport(t) {
    const data = tabToData(t);
    if (exportPhotos && t.imageFile) {
        data.image = { name: t.fileName || 'photo', type: t.imageFile.type || 'image/jpeg', dataUrl: await blobToDataURL(t.imageFile) };
    }
    return data;
}

// The photo inside a session file, as a File; null when it is not a base64 image.
const IMAGE_DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,/i;
function embeddedImageFile(image) {
    if (!image || typeof image.dataUrl !== 'string') return null;
    const head = IMAGE_DATA_URL.exec(image.dataUrl.slice(0, 80));
    if (!head) return null;
    try {
        const bin = atob(image.dataUrl.slice(head[0].length));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const name = typeof image.name === 'string' && image.name ? image.name.slice(0, 255) : 'photo';
        return new File([bytes], name, { type: head[1].toLowerCase() });
    } catch { return null; }
}

// A tab from session data; every field is checked, anything odd is dropped.
function tabFromData(sd) {
    const t = newTab();
    if (Array.isArray(sd.points)) {
        t.points = sd.points.filter(p => p && finite(p.x) && finite(p.y)).slice(0, 3).map(p => ({ x: p.x, y: p.y }));
    }
    const num = v => (typeof v === 'string' && /^[\d.,]{0,20}$/.test(v)) ? v : finite(v) ? String(v) : '';
    t.h = num(sd.height); t.l = num(sd.length);
    if (sd.time && typeof sd.time === 'object') {
        SEGS.forEach(s => {
            const v = sd.time[s];
            if (typeof v === 'string' && new RegExp(`^\\d{0,${SEG_LEN[s]}}$`).test(v)) t.dt[s] = v;
        });
    }
    t.mode = sd.mode === 'local' ? 'local' : 'utc';
    t.exif = exifFromData(sd.exif);
    t.exifDt = readExifTime(t.exif);
    if (sd.adjust && typeof sd.adjust === 'object') {
        ['contrast', 'brightness', 'saturation'].forEach(k => {
            if (finite(sd.adjust[k])) t.adjust[k] = Math.min(200, Math.max(0, Math.round(sd.adjust[k])));
        });
        t.adjust.invert = sd.adjust.invert === true;
    }
    if (finite(sd.opacity)) t.opacity = Math.min(1, Math.max(0, sd.opacity));
    const name = typeof sd.imageFilename === 'string' && sd.imageFilename ? sd.imageFilename.slice(0, 255) : '';
    t.pendingImage = name;
    t.fileName = '';
    return t;
}

// Replaces the shadows with those of a session. images[i]: a File for shadow i, or null.
function applySession(list, images = [], activeIndex = 0) {
    tabs.forEach(t => { cancelCalc(t); removeExifGps(t); });
    tabs = list.slice(0, MAX_OBS).map(tabFromData);
    if (!tabs.length) tabs = [newTab()];
    active = tabs[Number.isInteger(activeIndex) && tabs[activeIndex] ? activeIndex : 0];
    syncObservations();
    loadTabIntoUI();
    renderBands();
    tabs.forEach((t, i) => {
        t.framed = t !== active;   // only the selected shadow turns the map
        if (images[i]) loadImage(images[i], t, null, { restore: true });
        onInputChanged(t, { delay: 0, quiet: true });
    });
}

const hasWork = () => tabs.some(t => t.img || t.pendingImage || t.points.length || t.h || t.l || SEGS.some(s => t.dt[s]));

function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}
const exportStamp = () => new Date().toISOString().slice(0, 16).replace('T', '_').replace(/:/g, '-');

async function exportShadows(list, filename, doneText) {
    if (!list.length) return showToast('Nothing to export yet.');
    let data;
    try {
        data = [];
        for (const t of list) data.push(await tabToExport(t));
        downloadJSON({ json_version: SESSION_VERSION, app: 'ShadowFinder Web', exported: new Date().toISOString(), show: showMode, shadows: data }, filename);
    } catch {
        return showToast(exportPhotos ? 'Export failed: the photos are too large for one file. Switch off "Include photos".' : 'Export failed.');
    }
    showToast(doneText + (exportPhotos && list.some(t => t.imageFile) ? ' Photos included.' : ''), 'success');
}
const tabHasWork = t => t.img || t.pendingImage || t.points.length || t.h || t.l || SEGS.some(s => t.dt[s]);
const exportThis = () => exportShadows([active], `shadowfinder_shadow-${tabIndex(active)}_${exportStamp()}.json`, 'Shadow exported.');
const exportAll  = () => exportShadows(tabs.filter(tabHasWork), `shadowfinder_${exportStamp()}.json`, 'Session exported.');

function importSession(file) {
    const reader = new FileReader();
    reader.onload = e => {
        let data;
        try { data = JSON.parse(e.target.result); } catch { return showToast('That is not a ShadowFinder session file.'); }
        const list = Array.isArray(data?.shadows) ? data.shadows.filter(sd => sd && typeof sd === 'object') : [];
        if (!list.length) return showToast('No shadows found in that file.');
        if (hasWork() && !confirm('Replace the current shadows with the ones in this file?')) return;
        if (data.show === 'one' || data.show === 'all') showMode = data.show;
        applySession(list, list.map(sd => embeddedImageFile(sd.image)));
        const n = Math.min(list.length, MAX_OBS);
        showToast(`${n} shadow${n > 1 ? 's' : ''} imported.` + (list.length > MAX_OBS ? ` Only the first ${MAX_OBS} were kept.` : ''), 'success');
        scheduleAutosave();
    };
    reader.readAsText(file);
}
$('json-picker').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) importSession(f);
    e.target.value = '';
});

// ---- autosave (IndexedDB "shadowfinder": key "session" = the JSON, "img:<uid>" = each photo) ----
// Only one browser tab writes (the one holding the Web Lock), so two open tabs can't overwrite
// each other's photos.

let autosaveDb = null;
function openAutosaveDb() {
    if (!autosaveDb) autosaveDb = new Promise((resolve, reject) => {
        const req = indexedDB.open('shadowfinder', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('autosave');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return autosaveDb;
}
function autosaveTx(mode, fn) {
    return openAutosaveDb().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction('autosave', mode);
        const req = fn(tx.objectStore('autosave'));
        tx.oncomplete = () => resolve(req?.result);
        tx.onerror = tx.onabort = () => reject(tx.error);
    }));
}
function autosaveFailed() {
    if (autosaveWarned) return;
    autosaveWarned = true;
    showToast('Autosave failed: browser storage is full or blocked.');
}

function claimAutosave() {
    if (!navigator.locks) { autosaveOwner = true; return Promise.resolve(); }
    const hold = () => new Promise(() => {});
    return new Promise(resolve => {
        navigator.locks.request('shadowfinder-autosave', { ifAvailable: true }, lock => {
            if (!lock) { resolve(); return; }
            autosaveOwner = true; resolve();
            return hold();
        }).catch(() => { autosaveOwner = true; resolve(); });
    }).then(() => {
        if (autosaveOwner) return;
        // another tab writes; take over once it is closed
        navigator.locks.request('shadowfinder-autosave', () => {
            autosaveOwner = true;
            if (autosaveOn && autosaveReady) autosaveWrite();
            return hold();
        }).catch(() => {});
    });
}

function scheduleAutosave() {
    if (!autosaveOn || !autosaveReady || !autosaveOwner) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(autosaveWrite, 400);
}

function autosaveWrite() {
    clearTimeout(autosaveTimer);
    if (!autosaveOn || !autosaveReady || !autosaveOwner) return;
    const json = hasWork()
        ? JSON.stringify({ json_version: SESSION_VERSION, active: tabs.indexOf(active), show: showMode,
                           shadows: tabs.map(t => ({ ...tabToData(t), uid: t.uid })) })
        : null;
    const keep = new Set(tabs.filter(t => t.imageFile).map(t => 'img:' + t.uid));
    autosaveTx('readwrite', store => {
        if (json) store.put(json, 'session'); else store.delete('session');
        store.getAllKeys().onsuccess = e => {
            const have = new Set(e.target.result);
            have.forEach(k => { if (k !== 'session' && !keep.has(k)) store.delete(k); });
            tabs.forEach(t => { if (t.imageFile && !have.has('img:' + t.uid)) store.put(t.imageFile, 'img:' + t.uid); });
        };
    }).catch(autosaveFailed);
}

const autosaveClearStore = () => autosaveTx('readwrite', store => { store.clear(); }).catch(() => {});

async function autosaveRestore() {
    await claimAutosave();
    if (!autosaveOn) { if (autosaveOwner) await autosaveClearStore(); autosaveReady = true; return; }
    let json = null;
    try { json = await autosaveTx('readonly', store => store.get('session')); }
    catch { autosaveReady = true; return; }   // no IndexedDB here: work without autosave
    if (json != null) {
        try {
            const data = JSON.parse(json);
            const list = (Array.isArray(data.shadows) ? data.shadows : []).filter(sd => sd && typeof sd === 'object');
            if (!list.length) throw new Error('empty');
            const images = [];
            for (const sd of list.slice(0, MAX_OBS)) {
                const f = typeof sd.uid === 'string' ? await autosaveTx('readonly', store => store.get('img:' + sd.uid)) : null;
                images.push(f instanceof Blob ? new File([f], f.name || sd.imageFilename || 'photo', { type: f.type }) : null);
            }
            if (data.show === 'one' || data.show === 'all') showMode = data.show;
            applySession(list, images, data.active);
        } catch {
            if (autosaveOwner) await autosaveClearStore();
            showToast('The saved session could not be restored. Starting fresh.');
        }
    }
    autosaveReady = true;
}

function setAutosave(on) {
    autosaveOn = on;
    prefs.set(AUTOSAVE_KEY, on ? '1' : '0');
    if (on) { autosaveWarned = false; autosaveWrite(); showToast('Autosave on: your work is kept in this browser.', 'success'); }
    else { autosaveClearStore(); showToast('Autosave off: the saved copy was deleted.', 'success'); }
}

function clearSaved() {
    if (!autosaveOwner) return showToast('ShadowFinder is open in another tab: clear the saved session there.');
    if (!confirm('Delete the saved session and start empty? This cannot be undone.')) return;
    autosaveClearStore().then(() => {
        tabs.forEach(t => { cancelCalc(t); removeExifGps(t); });
        tabs = [newTab()];
        active = tabs[0];
        syncObservations(); renderBands(); loadTabIntoUI();
        showToast('Saved session cleared.', 'success');
    });
}

// ---- the session menu (☰ at the right end of the input bar) ----

function renderSessionMenu() {
    const menu = $('session-menu');
    menu.innerHTML = '';
    const close = () => openSessionMenu(false);
    const section = title => { const s = document.createElement('div'); s.className = 'panel-title'; s.textContent = title; menu.appendChild(s); };
    const arrow = up => `<span class="export-icon"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${
        up ? '<line x1="5" y1="9" x2="5" y2="2"/><polyline points="2,4.5 5,1.5 8,4.5"/>' : '<line x1="5" y1="1" x2="5" y2="8"/><polyline points="2,5.5 5,8.5 8,5.5"/>'}</svg></span>`;
    const entry = (html, title, enabled, action) => {
        const it = document.createElement('div');
        it.className = 'session-item' + (enabled ? '' : ' disabled');
        it.setAttribute('role', 'menuitem');
        it.innerHTML = html;
        it.title = title;
        if (enabled) it.addEventListener('click', () => { close(); action(); });
        menu.appendChild(it);
    };
    const switchRow = (label, title, checked, onChange, extra = '') => {
        const r = document.createElement('div');
        r.className = 'session-switch';
        r.title = title;
        const id = 'sw-' + label.toLowerCase().replace(/\W+/g, '-');
        r.innerHTML = `<label for="${id}">${label}</label><span class="session-row-end">${extra}<input type="checkbox" id="${id}" class="adjust-switch" role="switch" ${checked ? 'checked' : ''}></span>`;
        r.querySelector('input').addEventListener('change', e => onChange(e.target.checked));
        menu.appendChild(r);
        return r;
    };

    section('File');
    entry(`${arrow(true)} Import…`, 'Open a ShadowFinder session file (.json)', true, () => $('json-picker').click());
    entry(`${arrow(false)} Export this shadow`, 'Save the selected shadow: its points or typed values, its time and settings', tabHasWork(active), exportThis);
    entry(`${arrow(false)} Export all`, 'Save every shadow as one file', tabs.some(tabHasWork), exportAll);
    switchRow('Include photos', 'Store each photo inside the exported file, unchanged, with its EXIF and GPS, so an import restores it without asking. The file gets about a third bigger than the photos.',
        exportPhotos, on => { exportPhotos = on; prefs.set(EXPORT_PHOTOS_KEY, on ? '1' : '0'); renderSessionMenu(); });
    if (exportPhotos) {
        const n = document.createElement('div');
        n.className = 'session-note';
        n.textContent = 'Photos go into the file with their GPS data; it gets much bigger.';
        menu.appendChild(n);
    }

    section('This browser');
    const row = switchRow('Autosave', 'Keep the work in this browser so a refresh does not lose it. Off deletes the saved copy.',
        autosaveOn, on => { setAutosave(on); renderSessionMenu(); },
        `<button type="button" class="btn-clear-saved" ${autosaveOn && autosaveOwner && hasWork() ? '' : 'disabled'} title="Delete the saved session and start empty">Clear</button>`);
    row.querySelector('button').addEventListener('click', () => { close(); clearSaved(); });

    section('Demo');
    entry('Patriot, Germany', 'Load the demo photo; mark the teal box and its shadow', true, loadDemo);
}

function openSessionMenu(show) {
    if (show) renderSessionMenu();
    $('session-menu').style.display = show ? 'block' : 'none';
    $('btn-session').setAttribute('aria-expanded', String(show));
}
$('btn-session').addEventListener('click', e => { e.stopPropagation(); openSessionMenu($('session-menu').style.display === 'none'); });
document.addEventListener('click', e => { if (!$('session-wrap').contains(e.target)) openSessionMenu(false); });
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') openSessionMenu(false);
    // Ctrl+S saves everything, as in TracePoint
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); exportAll(); }
});

// ---- HELP ----

$('btn-help').addEventListener('click', () => {
    const card = $('help-card');
    card.style.display = card.style.display === 'none' ? 'block' : 'none';
});
$('btn-help-close').addEventListener('click', () => { $('help-card').style.display = 'none'; });

// ---- DIVIDER between photo and map (as in TracePoint) ----
// Drag the handle to resize, double-click for 50/50, arrow keys when it has focus (Shift: 10%).
// The photo side's share is a percentage in --split on #app, so it scales with the window. Each
// side keeps its minimum width: minA for the photo side (below ~560 px the shadow tabs get cut),
// minB for the map (its bars fit down to ~420 px). The share is remembered; folding the photo
// side away is not, since the input lives there and a page loading without it would look broken.
// The canvas follows through its ResizeObserver, the map through MapLibre's own.

function makeSplitter(handle, box, { cssVar, key, minA = 560, minB = 420, start = 50, enabled = () => true }) {
    let pct = start;
    const size  = () => box.clientWidth || 1;
    const clamp = p => {
        const lo = minA / size() * 100, hi = 100 - minB / size() * 100;
        // a window too narrow for both minimums splits in their proportion
        if (lo > hi) return minA / (minA + minB) * 100;
        return Math.max(lo, Math.min(hi, p));
    };
    function set(p, save) {
        pct = clamp(p);
        box.style.setProperty(cssVar, `${pct.toFixed(2)}%`);
        handle.setAttribute('aria-valuenow', Math.round(pct));
        if (save) prefs.set(key, pct.toFixed(2));
    }

    handle.addEventListener('pointerdown', e => {
        if (e.button !== 0 || e.target.closest('button') || !enabled()) return;
        handle.setPointerCapture(e.pointerId);
        handle.classList.add('dragging');
        document.body.classList.add('pane-resizing');
        e.preventDefault();
        handle.focus();
    });
    handle.addEventListener('pointermove', e => {
        if (!handle.classList.contains('dragging')) return;
        const r = box.getBoundingClientRect();
        set((e.clientX - r.left) / r.width * 100, false);
    });
    const end = () => {
        if (!handle.classList.contains('dragging')) return;
        handle.classList.remove('dragging');
        document.body.classList.remove('pane-resizing');
        set(pct, true);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('dblclick', e => { if (!e.target.closest('button') && enabled()) set(start, true); });
    handle.addEventListener('keydown', e => {
        if (e.target !== handle || !enabled()) return;
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        set(pct + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1), true);
    });
    window.addEventListener('resize', () => set(pct, false));   // the pixel minimums follow the window

    const saved = parseFloat(prefs.get(key));
    set(Number.isFinite(saved) ? saved : start, false);
}

(() => {
    const app = $('app'), btn = $('btn-pane-collapse');
    const collapsed = () => app.classList.contains('photo-collapsed');
    makeSplitter($('pane-splitter'), app, { cssVar: '--split', key: 'sf-split', minA: 560, minB: 420, enabled: () => !collapsed() });
    btn.addEventListener('click', () => {
        const on = app.classList.toggle('photo-collapsed');
        const label = on ? 'Show the photo side' : 'Hide the photo side';
        btn.title = label;
        btn.setAttribute('aria-label', label);
        btn.blur();
    });
})();

// ---- START ----

loadTabIntoUI();
autosaveRestore().then(startIdleSpin);   // spins only when nothing was restored

// Until the first band, the map shows the day and night of this moment; the terminator moves
// 0.25° a minute, so a repaint each minute keeps it current (renderBands repaints only then).
renderBands();
setInterval(() => { if (!observations.length && !document.hidden) renderBands(); }, 60000);
