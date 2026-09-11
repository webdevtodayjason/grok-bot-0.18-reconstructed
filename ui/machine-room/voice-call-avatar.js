/* VOICE-13: the motion on the call screen's avatar, and nothing else.
 *
 * voice.js owns the screen, the socket and the state machine. This module owns one animation loop and
 * three functions, and it no-ops entirely where the mascot kit cannot run -- which is the same
 * contract index.html already writes down for voice.js and cloud-browser.js.
 *
 * THE ONE RULE, and it decides everything in here:
 *
 *   NO SCALE ON THE <titan-mascot> ELEMENT, OR ANYWHERE IN ITS ANCESTOR CHAIN, EVER.
 *
 * The vendored kit's resize() reads host.getBoundingClientRect().width (assets/titan-mascot.js),
 * which is transform-aware, while the ResizeObserver border box it fires from is not. MEASURED on
 * MacBook-Pro.local in both engines at 390x844: with the level at its peak and a resize landing, the
 * kit read a 433.35 px host for a 390 px element, set canvas.style.height to 294.68 px against an
 * unchanged 390 px CSS width, allocated 867x589, and Titan stayed 5.6% vertically stretched FOR THE
 * REST OF THE CALL because nothing re-measures. WebKit also logs "ResizeObserver loop completed with
 * undelivered notifications" from it, which fails a clean-console leg at random.
 *
 * So: the two halo SIBLINGS take transform and opacity; the mascot takes opacity and a drop-shadow,
 * neither of which changes getBoundingClientRect. A translate is fine and is what mascots.css already
 * does for centring, because a translate does not change rect.width. Rotation and orientation are
 * then safe by construction, which is why the element's width may be a vw expression at all.
 *
 * SIZE. The body is 0.422 of the canvas width at every size and STOPS GROWING where the canvas hits
 * the kit's own Math.min(430, width * .68) height clamp -- an element width of 632 px, giving
 * 266.5 x 244 CSS px of Titan, which is 68% of a 390 px phone and the largest the shipped kit can
 * draw. min(632px, 162vw) takes exactly that and the sides are clipped by the screen. It is free:
 * MEASURED, the main-thread share plateaus past a 480 px canvas (17.8%, 17.3%, 17.4% at 480, 560,
 * 700). The kit clamps dpr at 2, so on a real 3x iPhone screen Titan is upscaled 1.5x. Do NOT edit
 * assets/titan-mascot.js to get past the cap: ASSETS.md forbids editing that copy, tests/titan-crew
 * fails on drift, and the real change would move titanium.bot's marketing site too.
 */
(function attachVoiceCallAvatar(global) {
  "use strict";

  // The kit's three moods and no others. `set mood` THROWS a RangeError on anything else, so a
  // "listening" mood name is an exception and not a no-op.
  const MOOD_FOR = {
    Connecting: "calm",
    Listening: "calm",
    Thinking: "curious",
    Talking: "excited",
    Muted: "calm",
  };
  // Above this the Listening face is curious rather than calm: somebody is talking to him.
  const LEVEL_FLOOR = 0.12;
  // ONE POLE, ASYMMETRIC, IN JS RATHER THAN IN CSS. motion.css flattens every transition to 1 ms
  // globally under reduced motion, so a CSS-smoothed level would step and read as jitter.
  const ATTACK = 0.25;
  const DECAY = 0.08;
  // The divisor that makes a level a 0..1 number. MEASURED: the playback analyser's RMS on a real
  // stub reply reads 0.2588 to 0.2591, so a quarter is full scale.
  const LEVEL_FULL_SCALE = 0.25;

  const reducedMotion = () => {
    try { return global.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true; }
    catch { return false; }
  };

  const STILL_BASE = "assets/characters/titan-";
  const stillFor = (mood) => {
    const crew = global.TitanCrew;
    try { if (typeof crew?.stillFor === "function") return crew.stillFor(0, mood); }
    catch { /* the literal below is the fallback of the fallback */ }
    return `${STILL_BASE}${mood}.png`;
  };

  let host = null;
  let mascot = null;
  let still = null;
  let screen = null;
  let halo = null;
  let outer = null;
  let readLevels = null;
  let word = "Connecting";
  let level = 0;
  let frames = 0;
  let raf = null;
  let mood = "calm";

  /** Which number drives the motion in this state. The echo gate legitimately shuts the microphone
   * while Titan talks, so a Talking state reads playback and a Listening state reads the microphone. */
  function levelFor(state, stats) {
    const mic = Number(stats?.mic ?? 0) || 0;
    const out = Number(stats?.out ?? 0) || 0;
    if (state === "Muted") return 0;
    if (state === "Talking") return out;
    if (state === "Thinking") return 0;
    return mic;
  }

  function clamp01(value) { return value < 0 ? 0 : value > 1 ? 1 : value; }

  function smooth(current, target) {
    const rate = target > current ? ATTACK : DECAY;
    const next = current + (target - current) * rate;
    return Math.abs(next - target) < 0.002 ? target : next;
  }

  function setMood(next) {
    if (next === mood) return;
    mood = next;
    if (mascot != null) { try { mascot.setAttribute("mood", next); } catch { /* a kit that refuses keeps the old face */ } }
    if (still != null) still.src = stillFor(next);
  }

  function moodFor(state, value) {
    if (state === "Listening" && value > LEVEL_FLOOR) return "curious";
    return MOOD_FOR[state] ?? "calm";
  }

  function paint() {
    if (screen == null) return;
    // ONE CUSTOM PROPERTY, ONCE A FRAME, ON THE SCREEN AND NEVER ON documentElement: a document-level
    // write invalidates the whole page's style, and --kb's neighbourhood belongs to app.js. MEASURED:
    // a custom property once a frame is 0.9% of the main thread with no layout; writing the level into
    // the mascot's WIDTH is 16.8% with 1419 layouts over six seconds, so the width is never written.
    screen.style.setProperty("--voice-level", level.toFixed(3));
    const inner = word === "Talking" ? 0.22 : 0.18;
    if (halo != null) {
      halo.style.transform = `translate(-50%, -50%) scale(${(1 + inner * level).toFixed(3)})`;
      halo.style.opacity = (word === "Muted" ? 0.2 : 0.35 + 0.40 * level).toFixed(3);
    }
    if (outer != null) {
      outer.style.transform = `translate(-50%, -50%) scale(${(1 + inner * 0.6 * level).toFixed(3)})`;
    }
    if (mascot != null) {
      // Opacity and a drop-shadow only. Neither changes the rect the kit measures itself from.
      mascot.style.filter = level > 0.02 ? `drop-shadow(0 0 ${(12 * level).toFixed(1)}px rgba(127, 227, 220, .55))` : "none";
    }
  }

  function tick() {
    raf = null;
    frames += 1;
    let stats = null;
    try { stats = readLevels?.() ?? null; } catch { stats = null; }
    const raw = clamp01(levelFor(word, stats) / LEVEL_FULL_SCALE);
    level = smooth(level, raw);
    setMood(moodFor(word, level));
    paint();
    schedule();
  }

  function schedule() {
    if (host == null || mascot == null) return;
    const rafFn = global.requestAnimationFrame;
    raf = typeof rafFn === "function" ? rafFn(tick) : global.setTimeout(tick, 16);
  }

  function mount(faceNode, options = {}) {
    if (faceNode == null) return false;
    release();
    host = faceNode;
    screen = faceNode.closest?.(".voice-call") ?? faceNode;
    halo = faceNode.querySelector?.("[data-voice-call-halo]") ?? null;
    outer = faceNode.querySelector?.("[data-voice-call-halo-outer]") ?? null;
    readLevels = typeof options.levels === "function" ? options.levels : null;
    word = "Connecting";
    level = 0;
    frames = 0;
    mood = "calm";
    const doc = global.document;
    // REDUCED MOTION IS DESIGNED HERE, NOT INHERITED: the still, no rAF, no level read at all, and the
    // mood still changes the still. MEASURED at 2.7% of the main thread against 9.3%.
    const animated = typeof global.customElements === "object" && global.customElements != null && !reducedMotion();
    if (!animated) {
      still = doc.createElement("img");
      still.className = "voice-call-still";
      still.alt = "";
      still.src = stillFor(mood);
      faceNode.appendChild(still);
      return true;
    }
    mascot = doc.createElement("titan-mascot");
    // variant 0 is Titan. NO data-titan-agent: mascots.js's syncMoods sweep rewrites the mood on every
    // [data-titan-agent] face on every roster event, and this face is not a roster face. The precedent
    // is app.js's own onboarding face, which deletes that attribute and drives its own mood.
    mascot.setAttribute("variant", "0");
    mascot.setAttribute("mood", mood);
    // Thirteen eyes following a thumb is what this attribute exists to prevent everywhere else.
    mascot.setAttribute("tracking", "off");
    faceNode.appendChild(mascot);
    // play() is never called: mascots.js warns in its own comment that play() marks an element
    // manually played for good and overrides a later reduced-motion preference.
    paint();
    schedule();
    return true;
  }

  function setState(next) {
    const value = String(next ?? "");
    if (MOOD_FOR[value] == null) return;
    word = value;
    if (mascot == null) setMood(moodFor(word, 0));
  }

  function setLevels(mic, out) { readLevels = () => ({ mic: Number(mic) || 0, out: Number(out) || 0 }); }

  function release() {
    if (raf != null) {
      try { (global.cancelAnimationFrame ?? global.clearTimeout)(raf); } catch { /* gone */ }
      raf = null;
    }
    if (mascot != null) {
      try { mascot.setAttribute("paused", ""); } catch { /* a kit that refuses stops with the node */ }
      try { mascot.remove(); } catch { /* already gone */ }
    }
    if (still != null) { try { still.remove(); } catch { /* already gone */ } }
    mascot = null;
    still = null;
    host = null;
    screen = null;
    halo = null;
    outer = null;
    readLevels = null;
    level = 0;
  }

  global.__voiceCallAvatar = {
    mount,
    setState,
    setLevels,
    release,
    levelFor,
    get frames() { return frames; },
    get state() { return word; },
    get level() { return level; },
    get mood() { return mood; },
    _ATTACK: ATTACK,
    _DECAY: DECAY,
    _LEVEL_FULL_SCALE: LEVEL_FULL_SCALE,
    _LEVEL_FLOOR: LEVEL_FLOOR,
    _MOOD_FOR: MOOD_FOR,
    _smooth: smooth,
    _moodFor: moodFor,
    _stillFor: stillFor,
  };
})(typeof window === "undefined" ? globalThis : window);
