# Controls

Everything ShadowFinder Web can do, panel by panel. The photo and all input are on the left; the map is on the right.

## Shadows (tabs)

Each tab is one **shadow**: a photo with three marked points, or a typed height and shadow length, plus its capture time. Its band is recalculated as soon as the input is complete, so there is no Calculate button.

| Control | Action |
|---|---|
| **Shadow 1, 2, 3** | Switch shadows. The dot shows the state: busy, band found, or no place matches |
| **+** | New shadow: the same place at another time. Up to three (two give a fix, a third settles which of two crossings it is) |
| **×** on a tab | Remove that shadow. Closing the last one clears everything |
| Step icons on the photo | The four steps, the current one lit. Click the current step to do it (browse for a photo, jump to the time field, turn the map to the band) |

## Photo

| Input | Action |
|---|---|
| Drop, `Ctrl+V` or **Browse** | Load a photo. Several photos fill several tabs. A photo dropped on a shadow that already has a band starts a new shadow |
| **Try the demo** | Load the demo photo with its EXIF time, then mark its shadow |
| Click | Place the next point: **base**, **top**, **shadow tip** |
| Drag a point | Move it; the band follows when you pause |
| Drag the photo, `Space` + drag, middle-drag | Pan |
| Scroll | Zoom |
| **Fit** | Fit the photo into the panel |
| **Adjust** | Contrast, brightness, saturation, invert. Display only, the photo is not changed |
| **Original** | Compare with the photo without the adjustments |

The **∠** readout next to H and L is the angle between object and shadow. Green is reliable, yellow usable, red likely wrong; click it for why. See [method.md](method.md#the-shadow-angle).

## Height and shadow length

Without a photo, type **H** (object height) and **L** (shadow length) in any unit: only their ratio matters. With three points, the fields show the measured pixels. `Enter` moves on: H → L → time. **Reset** (↺ next to the fields) clears the points or the typed values.

## Capture time

| Input | Action |
|---|---|
| Typing | Digits run on through year, month, day, hour, minute, second. Seconds may stay empty |
| `↑` / `↓` | Change the part under the cursor |
| `-` `:` `/` `.` space | Finish the part |
| Paste | `2024-06-21T09:00:00`, `2024:06:21 09:00:00`, slashes or dots; a date alone fills only the date |
| Calendar button | Pick the day |
| **UTC / Local** | How to read the time. **Local** is the clock time where the photo was taken; it is converted with each place's own time zone (see [method.md](method.md#local-time)) |
| ↺ next to the time | Clear it |

**EXIF chip.** A photo's capture time fills in by itself. When the photo stores its time-zone offset (e.g. `+02:00`), the time is converted to UTC with it; without one it is read as UTC, so check it. Hover the chip for the photo's metadata. Once you edit the time, the chip reads **edited ↺** and a click restores the photo's time. When the photo has GPS, a click on the chip puts its position on the map as a pin (and removes it again).

## Map

| Control | Action |
|---|---|
| Base map (header) | Esri Dark Gray Canvas, OpenStreetMap or Esri World Imagery. The bands' colours change with it |
| **Globe / 2D** | Globe or flat Web Mercator map |
| Compass | North up and no tilt; on the globe it also brings the equator to the middle |
| Drag / scroll / right-drag | Move / zoom / rotate and tilt |
| **Paste coordinates…** | Pin a place (formats below). The pin says which bands cover it |
| Sun readout | Sun elevation from your H / L ratio, and the ring's radius |
| **Centre on the ring** | Turn the map to where the sun stood straight overhead (UTC times only) |
| **Selected / Overlap** | With two or more shadows: show only the selected shadow's band, or every band plus their overlap |
| **Layers** | An opacity slider per band, for the overlap and for the day/night shade. Double-click a slider to reset it |
| **Export** | The bands for Google Earth or GIS, see [export.md](export.md) |
| **?** | Short how-to card |
| Right-click | Copy the coordinates, open the spot in **TracePoint**, Google Maps, Street View, Google Earth, OpenStreetMap, or under *Open in…* Apple Maps, Lookmap, Bing Maps, Mapillary, Yandex Maps |

### Accepted coordinate formats

In the coordinate field, or with `Ctrl+V` anywhere on the page:

- Decimal: `52.39, 13.06` or `52.39 13.06`
- With hemispheres: `52.39° N, 13.06° E`, `N 52.39 E 13.06`
- Degrees, minutes, seconds: `52°23'24"N 13°03'36"E`
- Web Mercator metres: `1453000, 6867000`
- Links from Google Maps, Apple Maps, Bing, OpenStreetMap, Yandex, or any link with `lat=` and `lon=` / `lng=`

## Sessions

The **☰** menu at the right end of the input bar:

| Entry | Action |
|---|---|
| **Import…** | Open a session file (`.json`). It replaces the current shadows |
| **Export this shadow** / **Export all** (`Ctrl+S`) | Save the selected shadow, or all of them, as a `.json` file |
| **Include photos** | Put each photo into the exported file, unchanged (EXIF and GPS included), so an import does not ask for it. The file gets about a third bigger than the photos |
| **Autosave** | Keep the work in this browser, so a refresh does not lose it. Off deletes the saved copy |
| **Clear** | Delete the saved copy and start empty |
| **Demo** | Load the demo photo |

Without the photos, an imported session keeps the points and the time and asks you to drop each photo again; the bands are on the map before you do.

### Session file format

Plain JSON. Bands are not stored; they are recalculated on import.

```json
{
  "json_version": 1,
  "app": "ShadowFinder Web",
  "exported": "2026-11-21T12:00:00.000Z",
  "show": "all",
  "shadows": [
    {
      "name": "Shadow 1",
      "imageFilename": "photo.jpg",
      "points": [{ "x": 812.5, "y": 1034 }, { "x": 812, "y": 741.25 }, { "x": 1120, "y": 1040 }],
      "height": "", "length": "",
      "time": { "y": "2024", "mo": "04", "d": "14", "h": "13", "mi": "44", "s": "49" },
      "mode": "utc",
      "exif": { "DateTimeOriginal": "2024:04:14 13:44:49", "Make": "…" },
      "adjust": { "contrast": 100, "brightness": 100, "saturation": 100, "invert": false },
      "opacity": null,
      "image": { "name": "photo.jpg", "type": "image/jpeg", "dataUrl": "data:image/jpeg;base64,…" }
    }
  ]
}
```

`points` are in photo pixels (base, top, shadow tip). `height` and `length` are the typed values, used when there are no three points. `image` is there only with *Include photos*. Every field is checked on import and anything unexpected is dropped.

## Keyboard

| Key | Action |
|---|---|
| `Ctrl+V` | Paste a photo or coordinates |
| `Ctrl+S` | Export all shadows |
| `Space` + drag | Pan the photo |
| `Enter` | Next field |
| `Esc` | Close menus and cards |
