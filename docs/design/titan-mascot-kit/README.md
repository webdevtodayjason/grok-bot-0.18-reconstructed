# Titan — Mascot Animation Kit v1.1

Titan is the main agent of Titanium Bot, titanium.bot.

The approved mascot is a cyan, one-eyed alien with a small smile and a continuously morphing body. This package contains the animation code. It does not require generating more images to reproduce the character.

## Preview

Unzip the entire folder, then open **demo.html** in a current desktop browser. Keep **titan-mascot.js** beside it. No installation, account, API, fonts, image downloads, or build tools are required.

**approved-motion-preview.html** preserves the original approved conversation demo in a standalone page. The reusable component uses the same drawing functions and motion parameters, with additional lifecycle and accessibility handling. Responsive framing changes at small widths so it can fit a website component.

## Add Titan to a website

Copy `titan-mascot.js` into the site's public assets directory. Load it once, then use the custom element anywhere in the page:

```html
<script src="/assets/titan-mascot.js" defer></script>
<titan-mascot id="titan" mood="calm" style="width: 360px; max-width: 100%;"></titan-mascot>
```

Titan's canvas background is transparent. Place the element on a dark or light surface. The eye's cream color is part of the character. Avoid very small placements where the eye and smile cannot be read.

## Drive his mood from the product

```js
await customElements.whenDefined('titan-mascot');
const titan = document.querySelector('#titan');

titan.setMood('calm');      // Idle or waiting
titan.setMood('curious');   // Suggested mapping: listening or working
titan.setMood('excited');   // Suggested mapping: successful completion

titan.pause();
titan.play();
titan.reset();             // Return to the initial phase of the current mood
```

These are example mappings. Connect them to actual application events; the component does not connect to an AI service by itself. Return to `calm` after a completion celebration when appropriate for the product.

Attributes can also control the component:

```html
<titan-mascot mood="curious" tracking="off"></titan-mascot>
<titan-mascot mood="calm" paused></titan-mascot>
```

| API | Behavior |
| --- | --- |
| `mood="calm\|curious\|excited"` | Selects motion speed, deformation, and bounce. |
| `tracking="off"` | Disables pointer tracking; the eye continues its ambient gaze. |
| `paused` | Freezes autonomous motion. It is a boolean attribute; remove it to unset it. |
| `setMood(name)` or `.mood = name` | Changes mood smoothly while playing. Invalid method/property values throw. |
| `pause()` / `play()` | Controls playback. Explicit Play can override the initial reduced-motion preference. |
| `reset()` | Resets the phase and gaze without changing mood or playback state. |
| `snapshot()` | Returns a transparent PNG data URL of the current canvas frame. |
| `titan-statechange` | Event with `detail.mood` and `detail.paused`. |

Multiple Titan elements can run independently. The script registers the element only once.

## React / Next.js

The included **Titan.jsx** is a small React wrapper. Copy it next to `titan-mascot.js` in the application source directory, then use:

```jsx
<Titan mood="curious" width={320} />
```

The wrapper imports the browser component inside an effect, so server rendering does not evaluate browser globals. No React dependency is needed when using plain HTML.

## What makes this Titan

- One continuous cyan body; no separate limbs, horns, or antennae.
- One cream eye, one navy pupil, one white highlight, and a small curved smile.
- The eye remains readable while the outer contour flows.
- Slow idle motion; quicker, larger ripples when excited.
- Cyan body colors: `#23DCEF`, `#00C8F0`, `#00AFE0`.
- Eye: `#FFF9EF`; pupil and smile: `#0C203F`.

The body uses 120 contour samples and smooth curves. Several slow waves change the outline together, so the animation feels fluid. The blink, gaze, smile, and slight float are drawn separately. These are deterministic animation rules; their position in time varies with playback and pointer input.

To preserve consistency, reuse this component rather than redrawing the mascot independently for each screen. A GIF or video export would be a separate deliverable and would not preserve interactive gaze or live mood changes.

## Motion and integration notes

- Starts still when the browser reports `prefers-reduced-motion: reduce`; a deliberate `play()` starts it.
- Stops drawing when offscreen or the browser document is hidden.
- Cleans up observers, event listeners, and animation callbacks when removed.
- No network calls or data collection.
- Uses native Canvas 2D, custom elements, and browser observer APIs. Target current browsers; validate in your application's supported browsers before release.
- The character is rendered in code; the package is not a rigged 3D model, sprite sheet, Lottie file, or animated GIF.

## Files

- `titan-mascot.js` — reusable standalone component and canonical drawing code.
- `demo.html` — interactive example with mood and playback buttons.
- `approved-motion-preview.html` — the original approved motion study, exported as a complete page.
- `Titan.jsx` — optional React / Next.js wrapper.
- `README.md` — this handoff guide.

## Companion agents

Titan is `variant="0"`. Twelve companion designs are included as `variant="1"` through `variant="12"`. See `agents.json` for names, colors, eye shapes, and deformation settings. The variants are stable rather than re-randomized each time the page loads.

```html
<titan-mascot variant="1" mood="curious"></titan-mascot>
```

The `characters` folder contains 39 individual transparent PNG snapshots: Titan plus 12 companions, each in calm, curious, and excited moods. Each PNG retains the component canvas framing at 512 × 348 pixels. These are still images; the JavaScript component supplies the live animation.

The production landing page includes this component directly in the hero, plus the agent gallery and control-room preview.
