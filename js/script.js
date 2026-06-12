/* ============================================================
   ShadowFinder Web – script.js
   ============================================================ */

const canvas    = document.getElementById('image-canvas');
const ctx       = canvas.getContext('2d');
const container = document.getElementById('image-container');
const overlay   = document.getElementById('drop-overlay');

// ---- TOAST ----

const toastCounts = new Map();
const TOAST_DURATION = 7000;
const TOAST_MAX_STACK = 3;

function showToast(msg, type = 'error') {
    const count = toastCounts.get(msg) || 0;
    if (count >= TOAST_MAX_STACK) return;
    toastCounts.set(msg, count + 1);
    const tc = document.getElementById('toast-container');
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
    const tc = document.getElementById('toast-container');
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

// ---- STATE ----

let img = null;
let points = [];       // up to 3: [{x,y}, ...]  — canvas coords
let measureMode = false;

const POINT_LABELS  = ['Base', 'Top', 'Shadow tip'];
const POINT_COLORS  = ['#ffb300', '#00aaff', '#ff4d6d'];
const STEP_INSTRUCTIONS = [
    'Drop an image to begin, or enter values manually',
    'Click the base of the object',
    'Click the top of the object',
    'Click the tip of the shadow',
    'Set the date & time',
];

// pan/zoom
let scale = 1, offsetX = 0, offsetY = 0;
let isPanning = false, panStartX = 0, panStartY = 0, panOffsetX = 0, panOffsetY = 0;

// ---- MAP ----

const map = L.map('map-container', { center: [20, 0], zoom: 2, zoomControl: true, attributionControl: true });

const TILE_SETS = [
    {
        id: 'carto-dark',
        label: '🌑 Dark',
        layers: [{ url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', opts: { attribution: '© OpenStreetMap contributors © CARTO', maxZoom: 19 } }]
    },
    {
        id: 'osm',
        label: '🗺 OpenStreetMap',
        layers: [{ url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', opts: { attribution: '© OpenStreetMap contributors', maxZoom: 19 } }]
    },
    {
        id: 'esri-sat',
        label: '🛰 Satellite',
        layers: [
            { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', opts: { attribution: 'Tiles © Esri', maxZoom: 19 } },
            { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', opts: { attribution: '', opacity: 0.7, maxZoom: 19 } }
        ]
    }
];

let activeTileLayers = [];
function setTileSet(id) {
    activeTileLayers.forEach(l => map.removeLayer(l));
    activeTileLayers = [];
    const set = TILE_SETS.find(s => s.id === id) || TILE_SETS[0];
    set.layers.forEach(l => activeTileLayers.push(L.tileLayer(l.url, l.opts).addTo(map)));
    localStorage.setItem('sf-tileset', id);
}
setTileSet(localStorage.getItem('sf-tileset') || 'carto-dark');

const LayerSwitcher = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
        const wrap = L.DomUtil.create('div', 'layer-switcher-wrap');
        L.DomEvent.disableClickPropagation(wrap);
        const btn = L.DomUtil.create('button', 'layer-burger', wrap);
        btn.title = 'Switch map layer';
        btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <rect y="2"  width="16" height="2" rx="1"/>
            <rect y="7"  width="16" height="2" rx="1"/>
            <rect y="12" width="16" height="2" rx="1"/>
        </svg>`;
        const menu = L.DomUtil.create('div', 'layer-menu', wrap);
        menu.style.display = 'none';
        TILE_SETS.forEach(set => {
            const item = L.DomUtil.create('div', 'layer-item', menu);
            item.textContent = set.label;
            item.dataset.id = set.id;
            item.onclick = () => {
                setTileSet(set.id);
                menu.querySelectorAll('.layer-item').forEach(i => i.classList.remove('active'));
                item.classList.add('active');
                menu.style.display = 'none';
            };
        });
        const savedId = localStorage.getItem('sf-tileset') || 'carto-dark';
        menu.querySelector(`[data-id="${savedId}"]`)?.classList.add('active');
        btn.onclick = () => { menu.style.display = menu.style.display === 'none' ? 'block' : 'none'; };
        map.on('click', () => { menu.style.display = 'none'; });
        return wrap;
    }
});
new LayerSwitcher().addTo(map);

let heatmapLayer = null;
let resultOpacity = 0.85;
let observations = [];   // each: { id, label, baseEpochMs, mode, h, s, grid, dayGrid }
// Two observations give a fix with a two-point ambiguity; a third resolves it.
// Beyond three, extra bands can only shrink the AND-overlap and risk excluding the
// true spot, so the count is capped here.
const MAX_OBS = 3;

// While true, the last entry in `observations` is the "current" band being edited:
// recalculating replaces it rather than appending. "New observation" commits it (sets
// this false) so the next calculation starts a fresh band.
let editingCurrent = false;

// "New observation" commits the current band and starts the next, so it is only available
// once there is a current band to commit (or an image loaded to swap), and under the cap.
function refreshNewObsBtn() {
    const canStartNext = (img || editingCurrent) && observations.length < MAX_OBS;
    document.getElementById('btn-new-image').disabled = !canStartNext;
}

// "Clear all" is the global reset, so it is available the moment anything has been entered:
// an image, marked points, manual input, a date/time, or any band on the map.
function refreshClearAllBtn() {
    const anything = img || observations.length || points.length ||
        document.getElementById('input-date').value ||
        document.getElementById('input-time').value ||
        document.getElementById('manual-h').value ||
        document.getElementById('manual-l').value;
    document.getElementById('btn-clear-map').disabled = !anything;
}

function clearMap() {
    observations = [];
    if (heatmapLayer) { map.removeLayer(heatmapLayer); heatmapLayer = null; }
    resetInputPanel();   // full reset: clears the measurement, manual input, image, and disables
    updateObsList();     // Reset / New observation; refreshClearAllBtn (in resetInputPanel) greys this
}

// ---- STEP INDICATOR ----

function setStep(n) {
    const pill  = document.getElementById('step-pill');
    const instr = document.getElementById('step-instruction');
    const fill  = document.getElementById('step-fill');

    pill.classList.remove('complete');
    instr.textContent = STEP_INSTRUCTIONS[n - 1];
    fill.style.width = ((n - 1) / 5 * 100) + '%';
}

function setStepComplete() {
    const pill  = document.getElementById('step-pill');
    const instr = document.getElementById('step-instruction');
    const fill  = document.getElementById('step-fill');

    pill.classList.add('complete');
    instr.textContent = 'Ready — press Calculate';
    fill.style.width = '100%';
}

setStep(1);

// Clear browser-cached form values on every load
document.getElementById('input-date').value = '';
document.getElementById('input-time').value = '';

// ---- IMAGE LOAD ----

function loadImage(file) {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
        img = image;
        points = [];
        measureMode = false;
        // dropping an image returns to click-measurement mode
        manualMode = false;
        document.getElementById('btn-manual').classList.remove('active-mode');
        document.getElementById('manual-card').style.display = 'none';
        fitImage();
        canvas.style.display = 'block';
        overlay.style.display = 'none';
        document.getElementById('btn-reset').disabled = false;
        refreshNewObsBtn();
        refreshClearAllBtn();
        setStep(2);
        enterMeasureMode();
        drawCanvas();
    };
    image.onerror = () => showToast('Could not load image.');
    image.src = url;

    currentExif = null;
    document.getElementById('exif-wrap').style.display = 'none';
    exifr.parse(file, { tiff: true, exif: true, gps: true })
        .then(exif => { currentExif = exif || null; })
        .catch(() => { currentExif = null; })
        .finally(() => { document.getElementById('exif-wrap').style.display = 'block'; });
}

function fitImage() {
    const cw = container.clientWidth, ch = container.clientHeight;
    const iw = img.naturalWidth,      ih = img.naturalHeight;
    scale = Math.min(cw / iw, ch / ih, 1);
    offsetX = (cw - iw * scale) / 2;
    offsetY = (ch - ih * scale) / 2;
    canvas.width  = cw;
    canvas.height = ch;
}

// ---- TRANSFORMS ----

function imageToCanvas(ix, iy) {
    return { x: offsetX + ix * scale, y: offsetY + iy * scale };
}

function canvasToImage(cx, cy) {
    return { x: (cx - offsetX) / scale, y: (cy - offsetY) / scale };
}

// ---- DRAW ----

function drawCanvas() {
    if (!img) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
    drawPoints();
    if (points.length === 2) drawLine(points[0], points[1], POINT_COLORS[0], true);
    if (points.length === 3) {
        drawLine(points[0], points[1], POINT_COLORS[0], true);
        drawLine(points[0], points[2], POINT_COLORS[2], true);
    }
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

function drawLine(a, b, color, dashed) {
    const A = imageToCanvas(a.x, a.y), B = imageToCanvas(b.x, b.y);
    const ax = A.x, ay = A.y, bx = B.x, by = B.y;
    ctx.beginPath();
    if (dashed) ctx.setLineDash([4, 3]);
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.strokeStyle = color + 'aa';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
}

// ---- MEASURE MODE ----

function enterMeasureMode() {
    measureMode = true;
    canvas.style.cursor = 'crosshair';
}

function exitMeasureMode() {
    measureMode = false;
    canvas.style.cursor = 'default';
}

document.getElementById('btn-reset').addEventListener('click', () => {
    points = [];
    manualMode = false;
    document.getElementById('btn-manual').classList.remove('active-mode');
    document.getElementById('manual-card').style.display = 'none';
    document.getElementById('manual-h').value = '';
    document.getElementById('manual-l').value = '';
    exitMeasureMode();
    drawCanvas();
    document.getElementById('btn-calculate').disabled = true;
    document.getElementById('input-date').value = '';
    document.getElementById('input-time').value = '';
    document.getElementById('measure-info').style.display = 'none';
    document.getElementById('exif-card').style.display = 'none';
    setStickyToast(null);
    if (exifGpsMarker) { map.removeLayer(exifGpsMarker); exifGpsMarker = null; }
    // Reset clears the current measurement only; saved observation bands stay, and the
    // current band (if any) is still the one a re-measure + recalculate will replace.
    setStep(img ? 2 : 1);
    if (img) enterMeasureMode();
    refreshNewObsBtn();
    refreshClearAllBtn();
});

// Resets the left input panel to a clean slate: drops the image, clears the points, manual
// input, date/time and the measurement pill. Bands already on the map are not touched.
function resetInputPanel() {
    img = null;
    points = [];
    currentExif = null;
    manualMode = false;
    editingCurrent = false;
    document.getElementById('btn-manual').classList.remove('active-mode');
    document.getElementById('manual-card').style.display = 'none';
    document.getElementById('manual-h').value = '';
    document.getElementById('manual-l').value = '';
    exitMeasureMode();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.style.display = 'none';
    overlay.style.display = '';
    document.getElementById('btn-reset').disabled = true;
    document.getElementById('btn-calculate').disabled = true;
    document.getElementById('input-date').value = '';
    document.getElementById('input-time').value = '';
    document.getElementById('measure-info').style.display = 'none';
    document.getElementById('exif-card').style.display = 'none';
    document.getElementById('exif-wrap').style.display = 'none';
    document.getElementById('file-picker').value = '';
    setStickyToast(null);
    if (exifGpsMarker) { map.removeLayer(exifGpsMarker); exifGpsMarker = null; }
    setStep(1);
    refreshNewObsBtn();
    refreshClearAllBtn();
}

// "New observation" commits the current band (it stays on the map) and starts the next.
document.getElementById('btn-new-image').addEventListener('click', resetInputPanel);

document.getElementById('btn-clear-map').addEventListener('click', () => {
    clearMap();
});

function paintOpacitySlider() {
    const s = document.getElementById('opacity-slider');
    const pct = (s.value - s.min) / (s.max - s.min) * 100;
    s.style.background = `linear-gradient(to right, #ffb300 0%, #ffb300 ${pct}%, #5a5a5a ${pct}%, #5a5a5a 100%)`;
}
paintOpacitySlider();

document.getElementById('opacity-slider').addEventListener('input', e => {
    resultOpacity = parseFloat(e.target.value);
    if (heatmapLayer && heatmapLayer._canvas) heatmapLayer._canvas.style.opacity = resultOpacity;
    paintOpacitySlider();
});

// ---- CANVAS CLICK (place points) ----

canvas.addEventListener('click', e => {
    if (!img || isPanning) return;

    if (!measureMode) return;
    const rect = canvas.getBoundingClientRect();
    const { x: ix, y: iy } = canvasToImage(e.clientX - rect.left, e.clientY - rect.top);

    if (ix < 0 || iy < 0 || ix > img.naturalWidth || iy > img.naturalHeight) return;
    if (points.length >= 3) return;

    points.push({ x: ix, y: iy });
    drawCanvas();

    if (points.length === 1) setStep(3);
    else if (points.length === 2) setStep(4);
    else if (points.length === 3) {
        exitMeasureMode();
        setStep(5);
        checkDateTimeStep();
        document.getElementById('btn-calculate').disabled = false;
        updateMeasureInfo();
        showToast('3 points set — enter date & time, then Calculate.', 'success');
    }
});

// ---- MEASUREMENTS & ANGLE QUALITY ----

let manualMode = false;

function getManualMeasurements() {
    const h = parseFloat(document.getElementById('manual-h').value);
    const l = parseFloat(document.getElementById('manual-l').value);
    if (h > 0 && l > 0) return { h, s: l, angleDeg: 90, manual: true };
    return null;
}

function getMeasurements() {
    if (manualMode) return getManualMeasurements();
    if (points.length < 3) return null;
    const vObj  = { x: points[1].x - points[0].x, y: points[1].y - points[0].y };
    const vShad = { x: points[2].x - points[0].x, y: points[2].y - points[0].y };
    const h = Math.hypot(vObj.x, vObj.y);
    const s = Math.hypot(vShad.x, vShad.y);
    const cross = Math.abs(vObj.x * vShad.y - vObj.y * vShad.x);
    const dot   = vObj.x * vShad.x + vObj.y * vShad.y;
    const angleDeg = Math.atan2(cross, dot) * 180 / Math.PI;   // 0..180° between the two vectors
    return { h, s, angleDeg };
}

// Angle quality based on the displayed (rounded) degrees (symmetric around 90):
//   88..92   -> good       (square to the camera, reliable)
//   83..87 / 93..97 -> borderline (close, usable, expect some error)
//   else     -> bad        (foreshortened, result will be wrong)
// Asymmetric: the acute side (< 90°, shadow receding toward the horizon) is
// heavily foreshortened and unreliable; the obtuse side (> 90°, shadow toward
// the camera / foreground) is far more forgiving.
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
    if (q === 'bad')        setStickyToast(ANGLE_MSG.bad(a), 'error');
    else if (q === 'borderline') setStickyToast(ANGLE_MSG.borderline(a), 'warn');
    else                    setStickyToast(null);   // good — clear any lingering warning
}

function updateMeasureInfo() {
    const m = getMeasurements();
    const info = document.getElementById('measure-info');
    if (!m) { info.style.display = 'none'; setStickyToast(null); return; }

    if (m.manual) {
        // numbers entered directly — no in-image angle, no foreshortening warning
        document.getElementById('measure-h').textContent = +m.h.toFixed(2) + '';
        document.getElementById('measure-s').textContent = +m.s.toFixed(2) + '';
        info.className = 'manual q-good';
        info.style.display = 'flex';
        setStickyToast(null);
        return;
    }

    document.getElementById('measure-h').textContent = Math.round(m.h) + 'px';
    document.getElementById('measure-s').textContent = Math.round(m.s) + 'px';

    const angEl = document.getElementById('measure-angle');
    const q = angleQuality(m.angleDeg);
    const zone = q === 'good' ? 'good' : q === 'borderline' ? 'warn' : 'bad';
    angEl.textContent = '∠' + Math.round(m.angleDeg) + '°';
    angEl.className = 'measure-angle zone-' + zone;
    angEl.title = q === 'good'
        ? 'Shadow is perpendicular to the object — measurement is reliable.'
        : 'Click to see why this angle matters.';

    info.className = 'q-' + zone;
    info.style.display = 'flex';
    applyAngleWarning(m.angleDeg);
}

document.getElementById('measure-angle').addEventListener('click', () => {
    const m = getMeasurements();
    if (!m) return;
    if (m.manual) return;
    const a = Math.round(m.angleDeg);
    const q = angleQuality(m.angleDeg);
    if (q === 'good') showToast(ANGLE_MSG.good(a), 'success');
    else applyAngleWarning(m.angleDeg);   // re-show the lingering warning if it was dismissed
});

// ---- MANUAL INPUT MODE ----

function manualCardOpen() {
    return document.getElementById('manual-card').style.display !== 'none';
}

function openManual() {
    manualMode = true;
    document.getElementById('manual-card').style.display = 'block';
    document.getElementById('btn-manual').classList.add('active-mode');
    document.getElementById('step-pill').classList.remove('complete');
    document.getElementById('step-instruction').textContent = 'Manual input — enter height & length';
    document.getElementById('step-fill').style.width = '50%';
    document.getElementById('btn-calculate').disabled = !getManualMeasurements();
    updateMeasureInfo();
    checkDateTimeStep();
}

// keepMode=true when confirming (OK / Manual toggle); false when cancelling (×)
function closeManual(keepMode) {
    document.getElementById('manual-card').style.display = 'none';
    const valid = !!getManualMeasurements();
    if (keepMode && valid) {
        manualMode = true;
        document.getElementById('btn-manual').classList.add('active-mode');
        document.getElementById('btn-calculate').disabled = false;
    } else {
        manualMode = false;
        document.getElementById('btn-manual').classList.remove('active-mode');
        document.getElementById('btn-calculate').disabled = points.length < 3;
        setStep(points.length >= 3 ? 5 : (img ? 2 : 1));
    }
    updateMeasureInfo();
    checkDateTimeStep();
}

function onManualInput() {
    if (!manualMode) return;
    document.getElementById('btn-calculate').disabled = !getManualMeasurements();
    updateMeasureInfo();
    checkDateTimeStep();
    refreshClearAllBtn();
}

document.getElementById('btn-manual').addEventListener('click', () => {
    if (manualCardOpen()) closeManual(true); else openManual();
});
document.getElementById('btn-manual-ok').addEventListener('click', () => closeManual(true));
document.getElementById('btn-manual-close').addEventListener('click', () => closeManual(false));
document.getElementById('manual-h').addEventListener('input', onManualInput);
document.getElementById('manual-l').addEventListener('input', onManualInput);

// ---- PAN / ZOOM ----

container.addEventListener('wheel', e => {
    if (!img) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newScale = Math.max(0.1, Math.min(20, scale * factor));
    offsetX = mx - (mx - offsetX) * (newScale / scale);
    offsetY = my - (my - offsetY) * (newScale / scale);
    scale = newScale;
    drawCanvas();
}, { passive: false });

canvas.addEventListener('mousedown', e => {
    if (e.button === 1 || (e.button === 0 && e.getModifierState('Space'))) {
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

window.addEventListener('mouseup', e => {
    if (isPanning) {
        isPanning = false;
        canvas.style.cursor = measureMode ? 'crosshair' : 'default';
    }
});

window.addEventListener('keydown', e => { if (e.code === 'Space') e.preventDefault(); });

window.addEventListener('resize', () => {
    if (!img) return;
    fitImage();
    drawCanvas();
});

// ---- DRAG & DROP ----

container.addEventListener('dragover', e => {
    e.preventDefault();
    container.classList.add('drag-active');
});
container.addEventListener('dragleave', () => container.classList.remove('drag-active'));
container.addEventListener('drop', e => {
    e.preventDefault();
    container.classList.remove('drag-active');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) loadImage(file);
    else showToast('Please drop an image file.');
});

document.getElementById('btn-browse').addEventListener('click', () => {
    document.getElementById('file-picker').click();
});
document.getElementById('file-picker').addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) loadImage(file);
});

// ---- STEP 5: DATE/TIME FILLED ----

function checkDateTimeStep() {
    const dateVal = document.getElementById('input-date').value;
    const timeVal = document.getElementById('input-time').value;
    const ready = manualMode ? !!getManualMeasurements() : points.length >= 3;
    if (ready && dateVal && timeVal) {
        setStepComplete();
    }
}
// 'input' (not just 'change') so Clear all lights up as soon as a date or time is typed.
['input-date', 'input-time'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => { checkDateTimeStep(); refreshClearAllBtn(); });
});

// ---- EXIF ----

let currentExif = null;
let exifGpsMarker = null;

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

function applyExifDateTime() {
    if (!currentExif) return;
    const raw = pick(currentExif, 'DateTimeOriginal', 'DateTimeDigitized', 'DateTime');
    if (!raw) return;
    let year, month, day, hour, minute, second = 0;

    if (raw instanceof Date) {
        // exifr builds the Date from the EXIF wall-clock with LOCAL constructors, so the
        // local getters read back exactly the digits stored in the file (no timezone shift).
        year = raw.getFullYear(); month = raw.getMonth() + 1; day = raw.getDate();
        hour = raw.getHours(); minute = raw.getMinutes(); second = raw.getSeconds();
    } else if (typeof raw === 'string') {
        const m = raw.match(/^(\d{4})[: -](\d{2})[: -](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
        if (!m) return;
        year = +m[1]; month = +m[2]; day = +m[3];
        hour = +m[4]; minute = +m[5]; second = m[6] ? +m[6] : 0;
    } else return;

    // An EXIF offset tag means the stored wall-clock is local time; with no offset we take
    // the value as already UTC (e.g. images prepared with the capture time written in UTC).
    const offsetStr = pick(currentExif, 'OffsetTimeOriginal', 'OffsetTime', 'OffsetTimeDigitized');
    const useLocal = typeof offsetStr === 'string' && /[+-]\d{2}:\d{2}/.test(offsetStr);

    document.getElementById('input-date').value =
        `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    document.getElementById('input-time').value =
        `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:${String(second).padStart(2,'0')}`;

    if (useLocal) {
        timeFormat = 'local';
        document.getElementById('btn-local').classList.add('active-toggle');
        document.getElementById('btn-utc').classList.remove('active-toggle');
    } else {
        timeFormat = 'utc';
        document.getElementById('btn-utc').classList.add('active-toggle');
        document.getElementById('btn-local').classList.remove('active-toggle');
    }
    checkDateTimeStep();
    document.getElementById('exif-card').style.display = 'none';
}

function renderExifCard() {
    const card = document.getElementById('exif-card');
    if (!currentExif) {
        card.innerHTML = '<p class="exif-empty">No metadata found in this image.</p>';
        return;
    }
    try {
        const e = currentExif;
        const lat = dmsToDecimal(e.GPSLatitude);
        const lng = dmsToDecimal(e.GPSLongitude);
        const latRef = e.GPSLatitudeRef;
        const lngRef = e.GPSLongitudeRef;
        const adjLat = lat != null ? (latRef === 'S' ? -lat : lat) : null;
        const adjLng = lng != null ? (lngRef === 'W' ? -lng : lng) : null;

        const date = pick(e, 'DateTimeOriginal', 'DateTimeDigitized', 'DateTime');
        const rows = [
            ['Date',       formatExifDate(date)],
            ['Camera',     [e.Make, e.Model].filter(Boolean).join(' ') || null],
            ['Lens',       e.LensModel || null],
            ['Focal len',  pick(e,'FocalLength') != null ? `${e.FocalLength} mm` : null],
            ['Aperture',   pick(e,'FNumber') != null ? `f/${e.FNumber}` : null],
            ['Shutter',    pick(e,'ExposureTime') != null ? `${e.ExposureTime < 1 ? '1/'+ Math.round(1/e.ExposureTime) : e.ExposureTime} s` : null],
            ['ISO',        pick(e,'ISO','ISOSpeedRatings')],
            ['GPS',        adjLat != null && adjLng != null ? `${adjLat.toFixed(5)}, ${adjLng.toFixed(5)}` : null],
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

        const useBtn  = date
            ? `<button class="exif-use-btn" id="btn-exif-use-dt">Use this date &amp; time</button>`
            : '';
        const gpsBtn  = adjLat != null && adjLng != null
            ? `<button class="exif-gps-btn" id="btn-exif-gps">${crosshair}Show on map</button>`
            : '';

        card.innerHTML =
            '<div class="exif-card-header">Image metadata</div>' +
            (rows.length ? `<table class="exif-table">${tableRows}</table>` : '<p class="exif-empty">No relevant metadata found.</p>') +
            useBtn + gpsBtn;

        card.querySelector('#btn-exif-use-dt')?.addEventListener('click', applyExifDateTime);
        card.querySelector('#btn-exif-gps')?.addEventListener('click', () => {
            goToExifGps(adjLat, adjLng);
            document.getElementById('exif-card').style.display = 'none';
        });
        card.querySelectorAll('.exif-copy-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                navigator.clipboard.writeText(btn.dataset.coords).catch(() => {});
            });
        });
    } catch {
        card.innerHTML = '<p class="exif-empty">Could not read metadata.</p>';
    }
}

function goToExifGps(lat, lng) {
    if (exifGpsMarker) { map.removeLayer(exifGpsMarker); exifGpsMarker = null; }
    const icon = L.divIcon({
        className: '',
        html: '<div class="exif-gps-marker"></div>',
        iconSize: [20, 20], iconAnchor: [10, 10]
    });
    const exifCoords = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    exifGpsMarker = L.marker([lat, lng], { icon })
        .bindPopup(
            `<div class="tp-popup-header">EXIF GPS Position</div>` +
            `<div class="tp-popup-body">` +
            `<span>${exifCoords}</span>` +
            `<button class="tp-copy-btn" data-action="copy-coords" data-coords="${exifCoords}" title="Copy coordinates">` +
            `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">` +
            `<rect x="5" y="5" width="9" height="9" rx="1"/><path d="M2 11V2h9"/>` +
            `</svg></button>` +
            `</div>`,
            { className: 'tp-popup tp-popup-exif' }
        )
        .addTo(map);
    exifGpsMarker.openPopup();
    map.setView([lat, lng], Math.max(map.getZoom(), 10));
}

// Delegated copy handler for popup coordinate buttons
document.addEventListener('click', e => {
    const btn = e.target.closest('[data-action="copy-coords"]');
    if (btn) navigator.clipboard.writeText(btn.dataset.coords).catch(() => {});
});

document.getElementById('btn-exif').addEventListener('click', e => {
    e.stopPropagation();
    const card = document.getElementById('exif-card');
    const open = card.style.display !== 'none';
    if (open) { card.style.display = 'none'; } else { renderExifCard(); card.style.display = 'block'; }
});

document.addEventListener('click', e => {
    const wrap = document.getElementById('exif-wrap');
    if (!wrap.contains(e.target)) document.getElementById('exif-card').style.display = 'none';
});

// ---- UTC / LOCAL TOGGLE ----

let timeFormat = 'utc';

document.getElementById('btn-utc').addEventListener('click', () => {
    timeFormat = 'utc';
    document.getElementById('btn-utc').classList.add('active-toggle');
    document.getElementById('btn-local').classList.remove('active-toggle');
});
document.getElementById('btn-local').addEventListener('click', () => {
    timeFormat = 'local';
    document.getElementById('btn-local').classList.add('active-toggle');
    document.getElementById('btn-utc').classList.remove('active-toggle');
});

// ---- HELP ----

document.getElementById('btn-help').addEventListener('click', () => {
    const card = document.getElementById('help-card');
    card.style.display = card.style.display === 'none' ? 'block' : 'none';
});
document.getElementById('btn-help-close').addEventListener('click', () => {
    document.getElementById('help-card').style.display = 'none';
});

// ---- CALCULATE ----

document.getElementById('btn-calculate').addEventListener('click', () => {
    // Recalculating the current band (editingCurrent) is always allowed; only starting a
    // brand-new band is capped.
    if (!editingCurrent && observations.length >= MAX_OBS) {
        showToast('Three observations is the most that helps. Remove one to add another.');
        return;
    }

    const dateVal = document.getElementById('input-date').value;
    const timeVal = document.getElementById('input-time').value;

    if (!dateVal || !timeVal) {
        showToast('Please enter a date and time.');
        return;
    }
    if (!manualMode && points.length < 3) {
        showToast('Please mark all 3 points on the image first.');
        return;
    }

    const m = getMeasurements();
    if (!m) {
        showToast('Enter a height and a shadow length.');
        return;
    }

    const [year, month, day]       = dateVal.split('-').map(Number);
    const [hour, minute, second = 0] = timeVal.split(':').map(Number);
    const baseEpochMs = Date.UTC(year, month - 1, day, hour, minute, second);

    const objectHeight = m.h;
    const shadowLength = m.s;

    if (!manualMode && shadowLength < 1) {
        showToast('Shadow length is too short — check your points.');
        return;
    }

    runAnalysis(baseEpochMs, objectHeight, shadowLength, timeFormat);
});

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
        const offset = Math.round((localMs - date.getTime()) / 60000);
        return offset;
    } catch {
        return 0;
    }
}

// ---- ANALYSIS ----

async function runAnalysis(baseEpochMs, objectHeight, shadowLength, mode) {
    document.getElementById('btn-calculate').disabled = true;
    document.getElementById('btn-calculate').textContent = 'Calculating…';

    try {
        let tzGrid = null;
        if (mode === 'local') {
            tzGrid = await loadTzGrid(new Date(baseEpochMs));
        }
        await new Promise(r => setTimeout(r, 20));
        const { grid, dayGrid, count } = findShadows(baseEpochMs, objectHeight, shadowLength, mode, tzGrid);
        if (!count) {
            showToast('No matching locations found for these inputs.');
        } else {
            // Recalculating the current band replaces it in place; otherwise this is a new band.
            const replacing = editingCurrent && observations.length > 0;
            const obs = {
                id: replacing ? observations[observations.length - 1].id : Date.now(),
                label: formatObsLabel(baseEpochMs, mode),
                baseEpochMs, mode, h: objectHeight, s: shadowLength, grid, dayGrid,
            };
            if (replacing) {
                observations[observations.length - 1] = obs;
            } else {
                observations.push(obs);
                editingCurrent = true;   // the just-added band is now the current one
            }
            renderBands();
            updateObsList();
            refreshNewObsBtn();
            if (!replacing && observations.length === 1) map.fitBounds([[-60, -180], [85, 180]]);
            if (observations.length >= 2 && overlapCount() === 0) {
                showToast('These bands do not overlap. Check the times, and that every shot is the same place.');
            }
        }
    } catch (err) {
        showToast('Calculation failed: ' + err.message);
    }

    document.getElementById('btn-calculate').disabled = false;
    document.getElementById('btn-calculate').textContent = 'Calculate';
    checkDateTimeStep();
}

// ---- SHADOW MATH ----

function findShadows(baseEpochMs, objectHeight, shadowLength, mode, tzGrid) {
    const angRes  = 0.5;
    const minLat  = -60, maxLat = 85;
    const minLon  = -180, maxLon = 180;

    const lats = [];
    for (let lat = minLat; lat < maxLat; lat += angRes) lats.push(lat);
    const lons = [];
    for (let lon = minLon; lon < maxLon; lon += angRes) lons.push(lon);

    const numLons = lons.length;
    const offsetMap = tzGrid?._offsetMap;

    // grid holds the match `diff` per cell (-1 = no match). One band per observation.
    const grid = new Float32Array(lats.length * numLons).fill(-1);
    // Day/night wash only makes sense for a single UTC instant.
    // In local mode every point is at its own clock time, so skip it.
    const dayGrid = (mode === 'local') ? null : new Uint8Array(lats.length * numLons);
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

            const pos = SunCalc.getPosition(dt, lat, lon);
            const alt = pos.altitude;
            if (alt <= 0) continue;

            if (dayGrid) dayGrid[i * numLons + j] = 1;

            const calcShadow = objectHeight / Math.tan(alt);
            const diff = Math.abs(calcShadow - shadowLength) / shadowLength;

            if (diff < 0.2) {
                grid[i * numLons + j] = diff;
                count++;
            }
        }
    }

    return { grid, dayGrid, count };
}

// ---- RENDER HEATMAP ----

const HeatmapLayer = L.Layer.extend({
    initialize(observations) {
        this._obs = observations;
        // the day/night wash only makes sense for a single UTC observation
        this._dayGrid = (observations.length === 1 && observations[0].mode !== 'local')
            ? observations[0].dayGrid : null;
    },
    onAdd(map) {
        this._map = map;
        this._canvas = document.createElement('canvas');
        Object.assign(this._canvas.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '400', opacity: resultOpacity });
        map.getContainer().appendChild(this._canvas);
        map.on('move zoom resize', this._scheduleRender, this);
        this._render();
    },
    onRemove(map) {
        this._canvas.remove();
        map.off('move zoom resize', this._scheduleRender, this);
    },
    _scheduleRender() {
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = requestAnimationFrame(() => { this._raf = null; this._render(); });
    },
    _render() {
        const map = this._map;
        const el = map.getContainer();
        const w = el.clientWidth, h = el.clientHeight;
        const canvas = this._canvas;
        canvas.width = w; canvas.height = h;

        const ctx = canvas.getContext('2d');
        const img = ctx.createImageData(w, h);
        const d = img.data;
        const obs = this._obs;
        const n = obs.length;
        const dayGrid = this._dayGrid;

        const lats = new Float64Array(h);
        const lons = new Float64Array(w);
        for (let py = 0; py < h; py++) lats[py] = map.containerPointToLatLng([0, py]).lat;
        for (let px = 0; px < w; px++) lons[px] = map.containerPointToLatLng([px, 0]).lng;

        for (let py = 0; py < h; py++) {
            const gi = (lats[py] + 60) / 0.5 | 0;
            if (gi < 0 || gi >= 290) continue;
            const base = gi * 720;
            for (let px = 0; px < w; px++) {
                let lon = ((lons[px] % 360) + 360) % 360;
                if (lon >= 180) lon -= 360;
                const gj = (lon + 180) / 0.5 | 0;
                if (gj < 0 || gj >= 720) continue;
                const idx = base + gj;

                // how many observations' bands cover this cell?
                let matchCount = 0, sumDiff = 0;
                for (let k = 0; k < n; k++) {
                    const dff = obs[k].grid[idx];
                    if (dff >= 0) { matchCount++; sumDiff += dff; }
                }

                const i4 = (py * w + px) * 4;
                if (matchCount === n) {
                    // overlap of every band (a single band when n === 1): bright
                    const t = (sumDiff / n) / 0.2;
                    d[i4]   = 255;
                    d[i4+1] = (179 * (1 - t)) | 0;
                    d[i4+2] = 0;
                    d[i4+3] = (220 * (1 - t)) | 0;
                } else if (matchCount > 0) {
                    // covered by some but not all bands: faint gold
                    d[i4]   = 255;
                    d[i4+1] = 179;
                    d[i4+2] = 0;
                    d[i4+3] = 38;
                } else if (dayGrid && dayGrid[idx]) {
                    // faint golden wash over the daylit part of the world
                    d[i4]   = 255;
                    d[i4+1] = 179;
                    d[i4+2] = 0;
                    d[i4+3] = 18;
                }
            }
        }
        ctx.putImageData(img, 0, 0);
    }
});

function renderBands() {
    if (heatmapLayer) { map.removeLayer(heatmapLayer); heatmapLayer = null; }
    if (observations.length) {
        heatmapLayer = new HeatmapLayer(observations).addTo(map);
    }
    refreshClearAllBtn();
}

function formatObsLabel(baseEpochMs, mode) {
    const dt = new Date(baseEpochMs);
    const p = v => String(v).padStart(2, '0');
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
            if (observations[k].grid[idx] < 0) { all = false; break; }
        }
        if (all) c++;
    }
    return c;
}

function updateObsList() {
    const wrap = document.getElementById('obs-wrap');
    const list = document.getElementById('obs-list');
    if (!observations.length) {
        wrap.style.display = 'none';
        document.getElementById('obs-menu').style.display = 'none';
        list.innerHTML = '';
        return;
    }
    wrap.style.display = 'flex';
    document.getElementById('obs-count').textContent = observations.length;
    list.innerHTML = observations.map((o, i) =>
        `<div class="obs-row">` +
            `<div class="obs-info">` +
                `<span class="obs-time">${o.label}</span>` +
                `<span class="obs-meas">H ${+o.h.toFixed(1)} · L ${+o.s.toFixed(1)}</span>` +
            `</div>` +
            `<button class="obs-remove" data-i="${i}" title="Remove this observation">×</button>` +
        `</div>`
    ).join('');
    list.querySelectorAll('.obs-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            const i = +btn.dataset.i;
            // Removing the current (last) band means the measurement no longer maps to a
            // band, so the next calculation should start a fresh one.
            if (editingCurrent && i === observations.length - 1) editingCurrent = false;
            observations.splice(i, 1);
            renderBands();
            updateObsList();
            refreshNewObsBtn();   // dropping back under the cap can re-enable "New observation"
        });
    });
}

document.getElementById('btn-observations').addEventListener('click', e => {
    e.stopPropagation();
    const menu = document.getElementById('obs-menu');
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
});
document.addEventListener('click', e => {
    if (!document.getElementById('obs-wrap').contains(e.target)) {
        document.getElementById('obs-menu').style.display = 'none';
    }
});
