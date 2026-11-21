# Exporting the bands

The download button in the map bar exports the shadow bands for use outside ShadowFinder Web. Everything is built in the browser; nothing is uploaded.

The images use the colours of the base map you have open: amber with a daylight wash on Esri Dark Gray Canvas, orange-red with a night shade on OpenStreetMap, magenta-violet with a stronger night shade on Esri World Imagery.

All three formats cover the area the bands are calculated for: **60°S to 85°N, on a 0.5° grid**, in **WGS 84 (EPSG:4326)**. A cell is in a band when the shadow length the sun would cast there is within **20%** of the measured one.

## Google Earth (`.kmz`)

A zip with `doc.kml` and one PNG per layer, each a `GroundOverlay` over its lat/lon box:

| Overlay | Image | Shown when exported |
|---|---|---|
| `Shadow N · <time>` | one band, bright where the match is exact, fading to the 20% edge | as on the map (hidden if *Selected* mode hides it) |
| `Overlap of all bands` | where every band matches (two or more shadows) | in *Overlap* mode |
| `Daylight · <time>` or `Night · <time>` | where the sun was up (dark map) or down (light map, imagery), for the selected shadow's UTC time; covers 90°S to 90°N | when the map shows it |

Each overlay's opacity is the one set in the map bar's Layers dropdown (KML `color` alpha), so the file opens looking like the map. Toggle and fade them in Google Earth's Places panel.

## GeoTIFF (`.tif`)

One RGBA image of the bands **as shown** (bands and overlap composited with their opacities, no daylight), 1440 × 580 px at **0.25° per pixel**, uncompressed. GeoTIFF tags: `ModelPixelScale`, `ModelTiepoint` (top-left corner at 180°W, 85°N), `GeoKeyDirectory` (geographic, pixel-is-area, EPSG:4326, degrees). Drag it into QGIS and it lands in place.

## GeoJSON (`.geojson`)

A `FeatureCollection` of `MultiPolygon` outlines (the 20% edge, traced from the grid): one feature per band, plus the overlap of all bands when there are two or more. Rings follow RFC 7946 (exterior counter-clockwise, holes clockwise); a band crossing the antimeridian is cut at ±180°.

Properties of a band (`kind: "observation"`): `shadow`, `label`, `time`, `time_basis` (`utc` / `local`; a local time has no zone), `object_height`, `shadow_length`, `height_length_ratio`, `sun_altitude_deg`, `tolerance`, `grid_resolution_deg`, `sf_geojson_version`. The overlap (`kind: "intersection"`) lists the `observations` it combines.

No Shapefile: GeoJSON and GeoTIFF open in every current GIS.
