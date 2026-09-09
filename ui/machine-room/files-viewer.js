/*
 * Files that open — the viewer behind every file row (CONSOLE-4, item 4).
 * -----------------------------------------------------------------------
 * Jason, on his own console: "When there is a file and I click Files, like when Titan created a
 * Markdown file for me, I can't do anything with it. If I go to his desktop and click Files, it
 * shows me files we've created, but I can't click, open, or view it."
 *
 * He was right three times over. The file tile was a plain <div> with no handler; the list counted
 * only the {type:"attachment"} carrier and so showed 1 of his 11 files; and the path it stored was
 * the raw file:// URL, for which the host answers null. Those three are fixed where they live, in
 * app.js and gateway-adapter.js. This file is the fourth part: what a person sees once the row is
 * clickable and the path is one the box will actually serve.
 *
 * It is loaded before app.js and attaches window.__filesViewer = { open, ... }. app.js routes its
 * three funnels here -- the desktop Files tile, the top-nav Files row, and the attachment in a
 * chat bubble -- so all three land on the same viewer. Nothing here reaches back into app.js
 * except through window.__mrUi, the small set of shared helpers app.js publishes: openPanel,
 * paragraphMarkup, maskSecrets and escapeHtml.
 *
 * NO NEW MACHINERY, on purpose:
 *
 *   - The panel is the same modal openEvidenceViewer and openExchangeViewer already use, so the
 *     dialog, its close behaviour and its styling are one implementation rather than three.
 *
 *   - Markdown is rendered by paragraphMarkup, the renderer every chat bubble already uses. It
 *     handles headings, bullets, numbered lists and inline marks, so a markdown file needs no
 *     library, and -- the part that matters -- a heading looks the same in a file as it does in
 *     the reply that announced it. It escapes before it marks up, which is what keeps a file an
 *     agent wrote from being markup on this page.
 *
 *   - Text arrives through the adapter's existing attachment reads, which are cached by path. That
 *     cache is the reason this file unwraps a file:// URL itself (localPathOf below) instead of
 *     trusting its caller: a read that failed under the URL form is cached as null under that key,
 *     and a viewer that passed the URL through would inherit the failure forever.
 *
 *   - maskSecrets is applied to file text exactly as fillAttachments applies it to the inline
 *     preview. A file is not a safer place to print `sk-...` than a chat bubble is.
 *
 * WHAT THIS CAN OPEN, said honestly. Only paths that came out of this agent's own transcript, and
 * there is no field anywhere in it a person can type a path into. That is a scope, not an access
 * control, and the difference matters: readAttachmentImage ignores agentId entirely and the text
 * and chunk reads derive the owner from the path itself, so the agentId this file passes is
 * decorative. The fence that actually holds is the host's own path check, backed by the tighter
 * one on the relay's /files route.
 *
 * NOT here: /workspace. Every worker's Shell runs in one shared directory with no per-agent
 * subdirectory, so the attachments path check cannot be reused for it and the host has no listing
 * command for it either. It needs its own command, its own cap and its own copy. GAP row, not a
 * rushed implementation.
 */
(function attachFilesViewer(global) {
  "use strict";

  // The shared helpers app.js publishes. Read through a function rather than captured at load:
  // this file is loaded before app.js, so nothing here may hold a reference taken at parse time.
  const ui = () => global.__mrUi ?? {};
  const escapeHtml = (value) => (ui().escapeHtml ?? ((v) => String(v ?? "")))(value);
  const maskSecrets = (value) => (ui().maskSecrets ?? ((v) => String(v ?? "")))(value);
  const paragraphMarkup = (text) => (ui().paragraphMarkup ?? ((v) => `<p>${escapeHtml(v)}</p>`))(text);

  // The same unwrap gateway-adapter.js does, repeated here rather than imported, because this is
  // the last gate before a path becomes a cache key and a URL. An agent's SendMessage attachment
  // carries a file:// URL (mcp-image-assets.ts tells the model to pass exactly that); every host
  // read takes the bare path and answers null for the URL form.
  function localPathOf(urlOrPath) {
    const s = String(urlOrPath ?? "");
    if (!/^file:\/\//i.test(s)) return s;
    try { return decodeURIComponent(new URL(s).pathname); } catch { return s.replace(/^file:\/\//i, ""); }
  }

  // How the file is shown, decided by extension. The four that get a real view are the four a
  // person actually receives from an agent: notes in markdown, output in text, a screenshot, a
  // report as PDF. Everything else is offered as a download rather than rendered into a guess.
  const MARKDOWN_EXT = new Set(["md", "markdown", "mdx"]);
  const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg", "heic", "heif"]);
  const TEXT_EXT = new Set([
    "txt", "text", "log", "csv", "tsv", "json", "jsonc", "ndjson", "yaml", "yml", "toml", "ini", "cfg", "conf",
    "env", "xml", "html", "htm", "css", "scss", "less", "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "rb", "go",
    "rs", "java", "kt", "c", "h", "cc", "cpp", "cs", "php", "swift", "sql", "sh", "bash", "zsh", "ps1", "tf",
    "diff", "patch", "rst", "adoc", "proto", "graphql", "vue", "svelte",
  ]);
  const extensionOf = (name) => (/\.([^./\\]+)$/.exec(String(name ?? ""))?.[1] ?? "").toLowerCase();
  function kindFor(name) {
    const ext = extensionOf(name);
    if (MARKDOWN_EXT.has(ext)) return "markdown";
    if (IMAGE_EXT.has(ext)) return "image";
    if (ext === "pdf") return "pdf";
    if (TEXT_EXT.has(ext)) return "text";
    return "download";
  }

  // A same-origin URL, not a blob. Two things depend on that: the browser's own PDF viewer will
  // only load one, and <a download> writes the file with the name the route puts in
  // content-disposition rather than a uuid.
  function downloadHref({ path, agentId }, { download = true } = {}) {
    const query = new global.URLSearchParams();
    if (agentId) query.set("agent", String(agentId));
    query.set("path", localPathOf(path));
    if (download) query.set("download", "1");
    return `/files?${query.toString()}`;
  }

  // A file is hard-wrapped; a chat message is not. That one difference is the whole reason this
  // function exists.
  //
  // paragraphMarkup is line by line, which is exactly right for an agent's reply: agents write one
  // long line per paragraph, and the line-by-line pass is what fixed the "lead sentence then a
  // list" bug that the block-based renderer got wrong. Feed it a markdown FILE and the same rule
  // turns every 80-column wrap into its own <p>, with paragraph spacing between them. Measured in
  // real Chrome on grok-bot-local-vm: a three-line wrapped paragraph in gate-notes.md rendered as
  // three separate paragraphs with a gap between each.
  //
  // Markdown's own rule is the fix: inside a paragraph a single newline is a space, not a break.
  // So the soft wraps are joined here, before the shared renderer sees them, and nothing about the
  // renderer -- or about how a chat bubble looks -- changes.
  //
  // A wrapped BULLET is the same bug wearing a different hat, and markdown already has the answer:
  // a plain line under a list item is a lazy continuation OF that item. So a bullet opens a run
  // the next line joins, which is why LIST_START is separated out from the blocks that close one.
  //
  // What never absorbs the line after it: a blank line, a heading, a quote, a table row, a rule,
  // an indented code line, and anything at all inside a fence. A fence is left strictly alone;
  // this renderer does not draw code blocks, and mangling the lines of one on the way past would
  // turn "not rendered as code" into "not readable at all".
  const LIST_START = /^\s{0,3}([-*+]\s|\d+[.)]\s)/;
  const BLOCK_START = /^(\s{0,3}(#{1,4}\s|>|\||-{3,}\s*$|\*{3,}\s*$|_{3,}\s*$)|\s{4,}\S)/;
  function unwrapSoftBreaks(text) {
    const out = [];
    let fenced = false;
    let joining = false;
    for (const raw of String(text ?? "").split("\n")) {
      const line = raw.replace(/\s+$/, "");
      if (/^\s{0,3}(```|~~~)/.test(line)) { fenced = !fenced; joining = false; out.push(line); continue; }
      if (fenced) { out.push(line); continue; }
      if (line.trim().length === 0 || BLOCK_START.test(line)) { joining = false; out.push(line); continue; }
      // A new item ends the previous item's run and opens its own.
      if (LIST_START.test(line)) { out.push(line); joining = !/\s{2,}$/.test(raw); continue; }
      // A deliberate hard break -- markdown's two trailing spaces -- is a break the writer asked
      // for, so it ends the join rather than being swallowed by it.
      const hardBreak = /\s{2,}$/.test(raw);
      if (joining) out[out.length - 1] += ` ${line.trim()}`;
      else out.push(line);
      joining = !hardBreak;
    }
    return out.join("\n");
  }

  const sizeLabel = (bytes) => {
    const n = Number(bytes) || 0;
    if (n <= 0) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  };

  // The Files panel's own copy. It used to say the host keeps no per-worker directory and that
  // everything a worker writes goes to one shared /workspace. That is true of /workspace and false
  // of the files this list is actually made of, which all live in the agent's own attachments/ and
  // assets/ directories. Wrong copy under a list of openable files reads as "these do not really
  // exist", so it says what the list is instead, and names the one thing it leaves out.
  const PANEL_NOTE = "The files this conversation carried, from this agent's own storage. "
    + "Files a worker wrote with Shell into the shared workspace are not in this list.";

  // ---- markup, all of it pure so the unit test measures the shipped strings ---------------------

  function downloadRowMarkup(file) {
    return `<a class="file-download" data-file-download href="${escapeHtml(downloadHref(file))}" download="${escapeHtml(file.name)}">Download</a>`;
  }

  function viewerShellMarkup(file) {
    return `<div class="file-viewer" data-file-viewer data-file-path="${escapeHtml(localPathOf(file.path))}" data-file-kind="${escapeHtml(kindFor(file.name || file.path))}">`
      + `<div class="file-viewer-head"><p class="file-viewer-meta" data-file-meta>Reading this file from the box…</p>${downloadRowMarkup(file)}</div>`
      + `<div class="file-viewer-body" data-file-body><div class="empty-state">Reading this file from the box…</div></div>`
      + `</div>`;
  }

  // The body, given whatever the host answered. Every branch that cannot show the file says which
  // of the two reasons it is -- the host would not read it, or it is not a kind this renders --
  // and the Download link above stays live in both, because a file you cannot preview is still a
  // file you can have.
  function bodyMarkup(kind, answer, file) {
    if (kind === "image") {
      if (answer?.dataUrl) {
        return `<img class="file-viewer-image" src="${escapeHtml(answer.dataUrl)}" alt="${escapeHtml(file.name)}"${answer.width ? ` width="${answer.width}"` : ""}${answer.height ? ` height="${answer.height}"` : ""} />`;
      }
      return `<div class="empty-state">The box could not serve this picture. Download it to open it here.</div>`;
    }
    if (kind === "pdf") {
      // An <embed> pointed at the same-origin route. Chrome paints it with its own PDF viewer; a
      // browser that does not shows nothing at all and no error, which is why the sentence under
      // it says what to do rather than promising a viewer that may not appear.
      return `<embed class="file-viewer-pdf" data-file-embed type="application/pdf" src="${escapeHtml(downloadHref(file, { download: false }))}" />`
        + `<p class="field-hint">If the document does not appear above, your browser has no built-in PDF viewer. Download opens it in the app you use for PDFs.</p>`;
    }
    // Nothing was read for this one and nothing will be: it is a kind this viewer does not
    // pretend to render. Said plainly, rather than as a failure, because nothing failed.
    if (kind === "download") {
      return `<div class="empty-state">There is no preview for this kind of file. Download it to open it in the app it belongs to.</div>`;
    }
    if (answer == null) {
      return `<div class="empty-state">The box would not read this file. It may have been cleared, or it is outside this agent's own storage.</div>`;
    }
    if (answer.kind === "binary") {
      return `<div class="empty-state">This is not a text file${answer.bytes ? ` (${sizeLabel(answer.bytes)})` : ""}. Download it to open it in the app it belongs to.</div>`;
    }
    // Masked before it is rendered, both branches. A file is not a safer place to print a token
    // than a chat bubble, and an agent's own notes are exactly where one ends up pasted.
    const text = maskSecrets(String(answer.text ?? ""));
    const truncated = answer.truncated === true
      ? `<p class="field-hint">Showing the first ${sizeLabel(64 * 1024)} of this file. Download it for the whole thing.</p>`
      : "";
    if (kind === "markdown") return `<div class="file-viewer-markdown">${paragraphMarkup(unwrapSoftBreaks(text))}</div>${truncated}`;
    return `<pre class="file-viewer-text">${escapeHtml(text)}</pre>${truncated}`;
  }

  function metaMarkup(kind, answer, file) {
    const bits = [
      kind === "markdown" ? "Markdown" : kind === "pdf" ? "PDF" : kind === "image" ? "Picture" : kind === "text" ? "Text" : "File",
      sizeLabel(answer?.bytes),
      file.from ? `from ${file.from}` : "",
    ].filter(Boolean);
    return escapeHtml(bits.join(" · "));
  }

  // ---- opening one -----------------------------------------------------------------------------

  // Which open this is. openPanel is shared, so a second file opened while the first is still
  // being read must not have the first one's bytes painted over it.
  let generation = 0;

  function paint(seq, file, kind, answer) {
    if (seq !== generation) return;
    const root = global.document?.querySelector("[data-file-viewer]");
    if (!root || root.dataset.filePath !== localPathOf(file.path)) return;
    const body = root.querySelector("[data-file-body]");
    if (body) body.innerHTML = bodyMarkup(kind, answer, file);
    const meta = root.querySelector("[data-file-meta]");
    if (meta) meta.innerHTML = metaMarkup(kind, answer, file);
  }

  function open(file) {
    const openPanel = ui().openPanel;
    if (typeof openPanel !== "function") return;
    const path = localPathOf(file?.path);
    if (!path) return;
    const name = file?.name || path.split("/").pop() || "file";
    const entry = { path, name, agentId: file?.agentId ?? null, from: file?.from ?? "" };
    const kind = kindFor(name);
    const seq = ++generation;
    openPanel("File", name, viewerShellMarkup(entry));

    // PDF and the unrenderable both go straight to their final state: neither reads bytes through
    // the gateway, so there is nothing to wait for and a spinner would be a lie.
    if (kind === "pdf" || kind === "download") {
      paint(seq, entry, kind, null);
      return;
    }

    const adapter = global.__machineRoomAdapter;
    if (kind === "image") {
      if (typeof adapter?.readAttachmentImage !== "function") return paint(seq, entry, "image", null);
      Promise.resolve(adapter.readAttachmentImage(path, entry.agentId))
        .then((image) => paint(seq, entry, "image", image))
        .catch(() => paint(seq, entry, "image", null));
      return;
    }
    if (typeof adapter?.readAttachmentText !== "function") return paint(seq, entry, kind, null);
    Promise.resolve(adapter.readAttachmentText(entry.agentId, path))
      .then((answer) => paint(seq, entry, kind, answer))
      .catch(() => paint(seq, entry, kind, null));
  }

  // The stylesheet, claimed by this file rather than by index.html. index.html is edited by three
  // other hands this wave; a module that carries its own styles is one fewer line for one of them
  // to land wrong, and adding the <link> there anyway is a no-op because of the check.
  function ensureStylesheet() {
    const doc = global.document;
    if (!doc?.head || doc.querySelector('link[href$="files-viewer.css"]')) return;
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = "files-viewer.css";
    doc.head.appendChild(link);
  }
  ensureStylesheet();

  global.__filesViewer = {
    open,
    // The pure pieces, exported for the unit test and the gate rather than re-implemented there.
    kindFor,
    downloadHref,
    bodyMarkup,
    unwrapSoftBreaks,
    viewerShellMarkup,
    localPathOf,
    PANEL_NOTE,
  };
})(typeof window !== "undefined" ? window : globalThis);
