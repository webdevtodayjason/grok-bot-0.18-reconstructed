// Paste into the desktop pane, without the noVNC sidebar.
//
// The pane in the Machine Room is an iframe onto the box's OWN noVNC: vnc.html out of the box
// image, proxied by this relay at /vnc/<display>/ so it rides the same login as everything else.
// Nothing here vendors a copy of that client and this file does not start to. It rewrites exactly
// one file on the way through -- vnc.html, never an asset, never another page -- and only by
// appending to its <head>. Every byte the box serves is still the box's.
//
// Two things go in.
//
// A style that hides noVNC's control bar. That bar is chrome for a standalone viewer: a logo, a
// fullscreen button, a settings drawer, and a clipboard panel four clicks deep. Inside a pane that
// already has the console's own header it is noise, and the clipboard panel is the exact thing
// this change exists to make unnecessary. It is hidden, not removed -- the pane's own "noVNC bar"
// button, and Cmd/Ctrl+Shift+B beside it, bring the whole bar back. That button is the way out if
// the bridge below ever stops working on some box image, and it needs no keyboard: hiding the
// anchor also hides noVNC's own drag handle, which is the only pointer route the client has.
//
// And a module that carries the clipboard both ways. The console posts
// {type:"titanbot-vnc-paste", text} at the frame and this hands the text to RFB.clipboardPasteFrom
// -- the same call noVNC's own clipboard panel makes, so the text lands on the box's X selection
// and the box's apps paste it normally. Anything the box copies comes back the other way as
// {type:"titanbot-vnc-clipboard", text}.
//
// It is a module because vnc.html's own boot script is one. `UI` is a module export there, not a
// window global, so there is nothing on `window` to reach for -- but importing "./app/ui.js" a
// second time hands back the very same singleton the page booted with, because module instances
// are keyed by resolved URL. UI.rfb here IS the connection on screen.

// One string, in one place, so the relay, the unit test and the dashboard gate all ask the same
// question of a served page: is the bridge in this file, and is it in it once.
export const VNC_BRIDGE_MARKER = "titanbot-vnc-bridge";

// The only file that gets rewritten. Named rather than inlined at the call site so the test can
// assert the rule instead of re-deriving it.
export const VNC_BRIDGE_FILE = "vnc.html";

const BRIDGE = `<style id="${VNC_BRIDGE_MARKER}">
/* Hidden, not deleted: the pane's own "noVNC bar" button and the chord below both bring the whole
   bar back. Two things measured against the box image rather than guessed: display:flex is this
   anchor's own resting value (.noVNC_vcenter sets it in app/styles/base.css), and #noVNC_hint_anchor
   is left alone because it is the drag hint on the OPPOSITE edge -- it reveals nothing, so hiding
   it bought nothing. The pointer route back is the button, not that element. */
#noVNC_control_bar_anchor { display: none !important; }
html.titanbot-vnc-bar #noVNC_control_bar_anchor { display: flex !important; }
</style>
<script type="module">
import UI from "./app/ui.js";

const ORIGIN = window.location.origin;
const framed = window.parent !== window;
const toParent = (message) => { if (framed) window.parent.postMessage(message, ORIGIN); };

// UI.rfb is null until the handshake finishes, and is replaced outright on every reconnect, so the
// clipboard listener is attached to whichever object is there now -- once per object.
let watched = null;
const armClipboard = () => {
  const rfb = UI.rfb;
  if (rfb == null || rfb === watched) return;
  watched = rfb;
  rfb.addEventListener("clipboard", (event) => {
    const text = event && event.detail ? event.detail.text : null;
    if (typeof text === "string" && text.length > 0) toParent({ type: "titanbot-vnc-clipboard", text });
  });
};
armClipboard();
window.setInterval(armClipboard, 1000);

const toggleBar = () => document.documentElement.classList.toggle("titanbot-vnc-bar");

window.addEventListener("message", (event) => {
  if (event.origin !== ORIGIN) return;
  const data = event.data;
  if (data == null || typeof data !== "object") return;
  if (data.type === "titanbot-vnc-bar") { toggleBar(); return; }
  if (data.type !== "titanbot-vnc-paste") return;
  const text = typeof data.text === "string" ? data.text : "";
  if (text.length === 0) return;
  armClipboard();
  // Said, not swallowed. A toast that reads "pasted" on a screen that never got the text is the
  // failure this whole pane exists to stop.
  if (UI.rfb == null) { toParent({ type: "titanbot-vnc-paste-failed", reason: "the screen is not connected yet" }); return; }
  try {
    UI.rfb.clipboardPasteFrom(text);
    toParent({ type: "titanbot-vnc-pasted", chars: text.length });
  } catch (error) {
    toParent({ type: "titanbot-vnc-paste-failed", reason: String(error && error.message ? error.message : error) });
  }
});

// noVNC stops every keydown on its canvas and forwards it to the box, so once the operator has
// clicked into the screen the console never sees a paste event at all. Two chords are taken back
// here, in the capture phase, before noVNC's handler on the canvas ever runs:
//
//   Cmd/Ctrl+Shift+B  shows the control bar again. One of the two ways out if this bridge fails;
//                     the other, the pane's own button, needs no keyboard.
//   Cmd+V             asks the console for its clipboard. Only the Command key: it reaches the box
//                     as Super+V, which no Linux app pastes on, so nothing is lost by taking it.
//                     Ctrl+V is deliberately NOT taken -- inside the box that is the paste every
//                     Linux app answers, and taking it would break copying inside the box to pull
//                     the browser's clipboard in. So on Windows and Linux, once the screen has the
//                     keyboard, the route in is the control bar, and the pane's note says only
//                     what is true before that: the paste works while the PANE has the keyboard.
window.addEventListener("keydown", (event) => {
  const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && key === "b") {
    event.preventDefault();
    event.stopImmediatePropagation();
    toggleBar();
    return;
  }
  if (event.metaKey && !event.ctrlKey && !event.shiftKey && key === "v") {
    event.preventDefault();
    event.stopImmediatePropagation();
    toParent({ type: "titanbot-vnc-paste-request" });
  }
}, true);
</script>
`;

// The rewrite. Anything that is not vnc.html comes back byte-identical -- same object, not a copy
// -- because the assets are a client's own JavaScript and CSS and this has no business in them.
//
// Idempotent twice over: a page that already carries the marker is returned untouched, and a page
// with no </head> to append to is returned untouched as well rather than guessed at. A box image
// that served such a file would show its desktop with the sidebar and no bridge, which the
// dashboard gate catches; silently mangling the page would be worse.
export function rewriteVncAsset(rest, body) {
  if (rest !== VNC_BRIDGE_FILE) return body;
  const html = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
  if (html.includes(VNC_BRIDGE_MARKER) || !html.includes("</head>")) return body;
  // A function replacement, so a $ in the bridge could never be read as a match reference.
  const injected = html.replace("</head>", () => `${BRIDGE}</head>`);
  return Buffer.isBuffer(body) ? Buffer.from(injected, "utf8") : injected;
}
