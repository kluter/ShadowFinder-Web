# Security & Privacy

What ShadowFinder Web does and does not do with your data, so you can decide before using it on sensitive material.

## Photos never leave your machine

A photo is drawn into a `<canvas>` and its EXIF is read in memory. No request carries image data. To verify, open **DevTools → Network** (`F12`) and load a photo: no request involving it appears.

```javascript
// Every request ShadowFinder Web makes:
// GET https://server.arcgisonline.com/.../tile/{z}/{y}/{x}   (Esri base maps)
// GET https://tile.openstreetmap.org/{z}/{x}/{y}.png        (OpenStreetMap)
// GET timezone_grid.json                                     (from the app's own folder, Local mode only)
// GET assets/DEMO_…jpg                                       (from the app's own folder, demo only)
// No CDN, no analytics, no image, no session data.
```

## What happens only when you click

- **Right-click menu.** It builds ordinary links to Google Maps, Street View, Google Earth, OpenStreetMap, Apple Maps, Lookmap, Bing Maps, Mapillary, Yandex Maps and TracePoint. Nothing is contacted until you click one, and a link carries only the clicked coordinate and the zoom, never your photo or session.
- **Pasted coordinates.** The app never reads the clipboard on its own; text arrives only when you paste. It is parsed in the browser and no geocoder is contacted.
- **Exports.** KMZ, GeoTIFF, GeoJSON and session files are built in the browser and downloaded. Nothing is uploaded.

## Autosave keeps your work in this browser

So that a refresh does not lose work, ShadowFinder Web saves the shadows **and their photos** in this browser's `IndexedDB`. Nothing is uploaded or synced: the copy exists only in this browser profile on this machine, and anyone who can use that profile can open the app and see it.

- **Autosave off** (☰ menu) deletes the saved copy at once and stores nothing from then on. Use it for sensitive material.
- **Clear** (☰ menu) deletes the saved copy and empties the workspace.
- A private window works as usual; the browser deletes the copy when the window closes.
- With the app open in two tabs, only the first one saves. The second restores the saved work, but its changes are not saved until the first tab is closed, and **Clear** works only in the first.

Coordinate pins and GPS pins are not saved. Besides that, `localStorage` holds five settings. `sessionStorage` and cookies are unused.

```javascript
// Verify in DevTools → Application → Storage
// localStorage:  { "sf-tileset": "dark" }        ← base map
//                { "sf-projection": "globe" }    ← globe or 2D
//                { "sf-split": "50.00" }         ← width of the photo side in percent
//                { "sf-autosave": "1" }          ← autosave on/off
//                { "sf-export-photos": "1" }     ← "Include photos" on/off
// IndexedDB:     shadowfinder → autosave         ← "session" (the shadows, as in an export) + one "img:…" per photo
//                                                  empty while autosave is off
// sessionStorage: empty · Cookies: none
```

## Imported files cannot run code

Importing a session reads plain data: points, numbers and times are type-checked, unknown keys are dropped, and every text (file names, EXIF) is escaped before it is shown. An embedded photo is used only as a `data:image/…` that the browser decodes as an image. There is no `eval()` and no raw HTML from a file. The worst a manipulated file can do is fail to import.

## The code is auditable

Plain HTML, CSS and JavaScript, no build step. The app's own logic is in `js/script.js` and `js/contours.js`, unminified: what you read is what runs.

| Library | Loaded from | Touches your data? |
|---|---|---|
| [MapLibre GL JS](https://maplibre.org/) 6.19.0 | bundled in `vendor/maplibre-gl/` | No, draws the globe and map tiles |
| [exifr](https://github.com/MikeKovarik/exifr) | bundled in `js/` | Reads EXIF locally, no network |

Nothing loads from a CDN, so no third-party host can swap the code that runs in your browser. To verify a bundled copy, compare it with the official release of the same version.

A **Content-Security-Policy** in `index.html` enforces this in the browser: scripts, styles and workers only from the app's own origin, images and requests only from there and the two tile servers. No inline scripts, no `eval`.

This tool was developed with AI assistance. That is disclosed because the [risks of opaque, AI-generated OSINT tools](https://www.dutchosintguy.com/post/vibe-coding-is-becoming-an-osint-risk) are real; the answer is readable code anyone can verify.

## Caveats

- **Map tiles reveal the area you view.** Tile requests encode the map coordinates, so a tile server can infer where you are looking. Use a VPN or Tor if that matters.
- **The map worker is outside the page's CSP.** MapLibre fetches tiles from a Web Worker, and a `<meta>` CSP does not reach workers. The worker is bundled code that requests only the tile URLs in `js/script.js`; to enforce it in the browser too, serve the site with the same policy as an HTTP `Content-Security-Policy` header.
- **Saved work and exported files are not encrypted.** Session files (especially with photos, which keep their GPS) and the autosaved copy are plaintext. Treat them like any other sensitive material.
- **Browser and OS trust.** If your browser or system is compromised, no web app can protect you.
