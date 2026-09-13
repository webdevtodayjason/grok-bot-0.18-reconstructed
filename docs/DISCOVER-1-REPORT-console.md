# DISCOVER-1 Console report

## Delivered

The Machine Room now consumes the relay's documented `GET /discover` response without deriving any discovery evidence in the browser. A Signal Cyan on Midnight welcome pill occupies the workspace-name position, shows the returned percentage, and opens the six returned rows with counts, completion marks, strikethroughs, and one Hide control.

The module polls on load and every 60 seconds while the page is open. It retires the pill when `hidden` is true or `pct` reaches 100. Hide posts to `/discover/hide`. General Settings contains one `Show the welcome bar` row, which posts to `/discover/show` through the same module and refreshes the relay-owned state.

The feature is isolated in `discover.js`; `app.js` was not changed. The phone breakpoint gives the pill a 44 px height and turns the dropdown into a bottom sheet.

## Measured browser geometry

Measurements came from headless Chrome with the fake `/discover` answer in `tests/machine-room-discover.test.mjs`.

| Viewport | Pill box | Dropdown or sheet box |
| --- | --- | --- |
| 1440x900 | x 276.61, y 16, width 203.38, height 34, right 479.98, bottom 50 | x 277, y 58, width 360, height 400.69, right 637, bottom 458.69 |
| 390x844 | x 58, y 93, width 174, height 44, right 232, bottom 137 | x 0, y 410.31, width 390, height 433.69, right 390, bottom 844 |

At both sizes the fake 50 percent answer filled exactly half of the progress track, all six rows were present, three completed rows were struck through, and the document had no horizontal overflow.

## Verification

Required regression command:

```text
node --test tests/machine-room-discover.test.mjs tests/machine-room-voice.test.mjs tests/machine-room-mobile.test.mjs

1..118
# tests 118
# suites 0
# pass 118
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 32399.023
```

Focused Settings compatibility check:

```text
node --test tests/machine-room-settings.test.mjs

1..37
# tests 37
# suites 0
# pass 37
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 67.671291
```

Syntax and diff checks:

```text
node --check ui/machine-room/discover.js
node --check ui/machine-room/settings.js
node --check tests/machine-room-discover.test.mjs
git diff --check

All four commands exited 0 with no output.
```

## Remaining risk

The console tests use the exact JSON shape in the brief through a fake route. End-to-end evidence against the separately implemented relay half remains dependent on that half landing with the same route paths and response fields.
