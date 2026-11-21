# How it works

ShadowFinder Web re-implements the method of Bellingcat's [ShadowFinder](https://github.com/bellingcat/ShadowFinder). For the background and worked examples, see [Bellingcat's article](https://www.bellingcat.com/resources/2024/08/22/shadow-geolocate-geolocation-locate-image-tool-open-source-bellingcat-measure/).

## The band

An object of height *H* casts a shadow of length *L* when the sun stands at the altitude where `tan(altitude) = H / L`. At one moment, the sun has that altitude only along a ring around the point where it stands straight overhead. That ring is the band.

1. The world is sampled on a **0.5° grid**, latitude 60°S to 85°N, as in the original.
2. At every grid point, the sun's altitude at the capture time gives the expected shadow, `H / tan(altitude)`.
3. A point is in the band when that expected shadow is within **20%** of the measured one. The band is brightest where the match is exact and fades out toward the 20% edge.

Sun positions use the formulas of [SunCalc](https://github.com/mourner/suncalc), the JavaScript twin of the original's `suncalc` package. They are built into `js/script.js` and split so that the sun is worked out once per moment instead of once per grid point; the result is identical.

Checked against the original: `height 10`, `shadow 8`, `2024-02-29 12:00 UTC` reproduces the ring from its README.

## Local time

A UTC time is one moment for the whole Earth. A **Local** time is a clock reading, which is a different moment in every time zone. Local mode uses Bellingcat's `timezone_grid.json` (the zone of every grid point) and converts the time to UTC at each point with that zone's offset on that date, daylight saving included. A Local band is therefore not a single ring, and the *Centre on the ring* button and the day/night shade are off for it.

When the photo's EXIF stores its time-zone offset (`OffsetTimeOriginal`, e.g. `+02:00`), the app uses it to convert the capture time to UTC exactly, which is more precise than Local mode. Without an offset, the EXIF time is read as UTC: check it, and switch to Local if the camera clock showed local time.

## Several shadows

The same place at two different times gives two bands that cross; with a third, the right crossing of the two stands out. In **Overlap** mode the map shows each band faintly and, on top, the cells inside every band, graded by their mean match. The overlap is turned into view when it first appears. Three shadows is the cap: more bands can only shrink the overlap, and an error in any one can cut out the true spot.

## The shadow angle

Shadow length is only accurate when the shadow runs **sideways across the frame**, about 90° to the object in the photo. Toward or away from the camera, perspective shortens or stretches it, and the band lands in the wrong place. The app measures the angle between the object line (base → top) and the shadow line (base → tip):

| Angle, object to shadow | Verdict |
|---|---|
| `88°` to `98°` | 🟢 good, reliable |
| `85°` to `87°`, or `99°` to `109°` | 🟡 borderline, usable |
| below `85°` or above `109°` | 🔴 likely wrong |

The grading is asymmetric: below 90° the shadow recedes toward the horizon and is heavily foreshortened, while above 90° (toward the camera) it is more forgiving. These thresholds are experimental, set by feel rather than rigorous testing. Contributions to refine them are welcome.

## What the band does not do

- It only rules places out. Combine it with terrain, climate, vegetation and other clues.
- It assumes flat ground and a vertical object. A slope under the shadow, or a leaning object, changes the ratio.
- Its grid is 0.5° (about 55 km north to south), and the 20% tolerance makes it wide on purpose. A narrow band comes from good input, not from a finer grid.

## The globe

The one deliberate difference from the original is the view: the original is a static equirectangular plot, while ShadowFinder Web draws the band on a **globe** you can turn and zoom. Same band, same data, in its true shape: a flat map stretches bands near the poles and cuts them at the date line, a globe does neither. A flat **2D** map is one click away.
