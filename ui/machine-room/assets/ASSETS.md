# Visual assets

- `design-reference.png` is the approved design-board image and is used only as a heavily blurred ambient backdrop in the standalone prototype.
- `avatar-*.svg` files are original, replaceable agent marks. They are intentionally separate assets so production avatars can be substituted without changing component markup.
- Interface geometry, glass, shadows, status colors, and motion are implemented in CSS instead of rasterized screenshots.

The prototype does not crop interface elements from the design board. Every control remains selectable, responsive HTML.

- `backgrounds/titan-nebula.webp` and `.thumb.webp`: Jason's nebula wallpaper (source `new-space-bg-titan.png`, 1672x941, delivered 2026-09-06 for the Titanium Bot product brand), re-encoded here at 1672 wide / 320 wide.

## The Titanium Bot brand and the Titan crew (2026-09-06)

- `titan-mascot.js` is a byte-identical copy of `docs/design/titan-mascot-kit/titan-mascot.js`
  (mascot animation kit v1.1). It registers the `<titan-mascot>` custom element and exposes
  `window.TitanCharacters`. Do not edit it here: change the kit and copy it across, so the console
  and the titanium.bot site draw the same character from the same code. `tests/titan-crew.test.mjs`
  fails if the two files drift.
- `characters/<name>-{calm,curious,excited}.png` are the kit's 39 transparent stills, 512x348 each.
  They are the fallback wherever the canvas cannot run: a browser without custom elements, and any
  browser whose owner asked for `prefers-reduced-motion: reduce`.
- `titanium-bot-logo.svg` is the product lockup from `docs/design/titanium-bot-site/`, drawn in the
  window bar at the header's own height. `favicon.svg` is the same mark as the tab icon.
- The crew roster itself (names, colours, eye shapes) lives in `docs/design/titan-mascot-kit/agents.json`
  and is mirrored in `ui/machine-room/mascot-crew.js`, which is the file the console reads.
- `backgrounds/habitat-1.webp` (+ thumb) is Jason's Habitat I (2026-09-07, from `~/Downloads/Habitat-1.png`, 1672x941),
  the first of the Habitat series; `cwebp -q 84 -resize 1920 0` and `-q 70 -resize 320 0` for the thumb.
  A series is one field on the entry in `backgrounds.js`; seasonal sets ship the same way.
- `backgrounds/habitat-2..5.webp` (+ thumbs) complete the Habitat series (Jason, 2026-09-07 08:13, `~/Downloads/Habitat2..5.png`);
  `crystal-dunes` and `deep-current` (+ thumbs) are the two painted plates from `bg2.png` and `bg3.png`, same conversion.
- `backgrounds/lab-1..3.webp` (+ thumbs) are The Lab series (Jason, 2026-09-07 08:56, `~/Downloads/The lab series 1..3.png`), same conversion.
