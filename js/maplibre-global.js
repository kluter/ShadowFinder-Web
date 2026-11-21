// Loads the locally bundled MapLibre GL (an ES module) and exposes it as `window.maplibregl`
// for the classic script.js, which runs after this module (both are deferred, in order).
import * as maplibregl from '../vendor/maplibre-gl/maplibre-gl.js';

// The worker is bundled next to the library. It is renamed from .mjs to .js so plain static
// servers send it with a JavaScript MIME type, so its URL has to be given explicitly.
maplibregl.setWorkerUrl(new URL('../vendor/maplibre-gl/maplibre-gl-worker.js', import.meta.url).href);

window.maplibregl = maplibregl;
