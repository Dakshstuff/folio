/* ============================================================================
   FOLIO — script.js
   The animated academic resource library.
   ----------------------------------------------------------------------------
   BACKEND SDK
   - Appwrite Web SDK, pinned at version 11.0.0:
       vendored as appwrite.sdk.js (loaded by index.html, no CDN needed);
       if that file is missing, ensureAppwriteSdk() falls back to the
       official CDN copies (jsDelivr → unpkg), path /dist/iife/sdk.min.js.
   - The IIFE build exposes the global `window.Appwrite` and requires no build
     step. APIs used (all verified against SDK 11.x):
       Client, Account (createEmailPasswordSession — with a legacy fallback to
       createEmailSession —, get, updatePassword, deleteSessions,
       listMemberships), Databases (list/get/create/update/delete documents +
       Query), Storage (createFile with chunked-upload progress callbacks,
       getFileDownload, getFileView), ID, Permission, Role, AppwriteException.

   SECURITY MODEL (summary — full details in README.md)
   - Roles are enforced by Appwrite: the `admins` team holds write permission
     on collections and the storage bucket; viewers authenticate but hold read
     permission only. The admin UI is gated by a *server-verified* team
     membership check (Account.listMemberships), never by a user-editable
     role value in the browser.
   - No API key ever ships to the browser. Privileged provisioning happens
     through backend/create_user.py on the administrator's machine.

   PREVIEW MODE (honest, explicit, never silent)
   - If FOLIO_CONFIG below still contains placeholders, Folio shows a
     configuration screen. From there you may open a clearly-labelled,
     read-only DESIGN PREVIEW driven by in-memory demo data so the interface
     can be reviewed without a backend. It is bannered at all times, writes to
     nothing persistent, performs no uploads, and is never shown when a real
     configuration is present.
   ========================================================================== */

/* ----------------------------------------------------------------------------
   1. CONFIGURATION — edit these values after creating your Appwrite project.
---------------------------------------------------------------------------- */
const FOLIO_CONFIG = {
  endpoint: "https://fra.cloud.appwrite.io/v1",
  projectId: "6ae7616a000f2e627728",
  databaseId: "folio",
  documentsCollectionId: "documents",
  subjectsCollectionId: "subjects",
  storageBucketId: "resources"
};

/* Optional advanced settings — safe to leave at their defaults.
   These IDs must match what you create in the Appwrite console. */
const FOLIO_ADVANCED = {
  profilesCollectionId: "profiles",
  versionsCollectionId: "document_versions",
  starredCollectionId: "starred",
  adminTeamId: "admins",
  viewerTeamId: "viewers",
  maxFileSizeMB: 25 // must match your Appwrite plan / bucket maximum
};

const APPWRITE_SDK_VERSION = "11.0.0";
/* CDN fallbacks (used only when the vendored appwrite.sdk.js is missing).
   NOTE: the IIFE build lives at dist/iife/sdk.min.js — there is NO
   dist/iife/appwrite.js in the package (it 404s). */
const APPWRITE_SDK_CDN = [
  "https://cdn.jsdelivr.net/npm/appwrite@" + APPWRITE_SDK_VERSION + "/dist/iife/sdk.min.js",
  "https://unpkg.com/appwrite@" + APPWRITE_SDK_VERSION + "/dist/iife/sdk.min.js",
];

async function ensureAppwriteSdk() {
  if (typeof window.Appwrite !== "undefined") return true;
  for (const url of APPWRITE_SDK_CDN) {
    try {
      await new Promise((resolve, reject) => {
        const tag = document.createElement("script");
        tag.src = url;
        tag.async = false;
        tag.onload = () => resolve();
        tag.onerror = () => { tag.remove(); reject(new Error("load failed: " + url)); };
        document.head.appendChild(tag);
      });
      if (typeof window.Appwrite !== "undefined") return true;
    } catch (e) {
      console.warn("[Folio] SDK fallback failed:", url, e);
    }
  }
  return false;
}
const PAGE_SIZE = 10;

/* File allowlist for academic resources (mirrored by the storage bucket's
   server-side extension allowlist — see README "Storage bucket"). */
const EXT_META = {
  pdf:  { cat: "pdf",          label: "PDF",  mime: "application/pdf" },
  docx: { cat: "document",     label: "DOCX", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  doc:  { cat: "document",     label: "DOC",  mime: "application/msword" },
  pptx: { cat: "presentation", label: "PPTX", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  ppt:  { cat: "presentation", label: "PPT",  mime: "application/vnd.ms-powerpoint" },
  xlsx: { cat: "spreadsheet",  label: "XLSX", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  xls:  { cat: "spreadsheet",  label: "XLS",  mime: "application/vnd.ms-excel" },
  txt:  { cat: "text",         label: "TXT",  mime: "text/plain" },
  csv:  { cat: "spreadsheet",  label: "CSV",  mime: "text/csv" },
  png:  { cat: "image",        label: "PNG",  mime: "image/png" },
  jpg:  { cat: "image",        label: "JPG",  mime: "image/jpeg" },
  jpeg: { cat: "image",        label: "JPEG", mime: "image/jpeg" },
  webp: { cat: "image",        label: "WEBP", mime: "image/webp" },
  mp4:  { cat: "video",        label: "MP4",  mime: "video/mp4" },
  zip:  { cat: "archive",      label: "ZIP",  mime: "application/zip" }
};
const CATEGORY_LABELS = {
  pdf: "PDFs", document: "Documents", presentation: "Presentations",
  spreadsheet: "Spreadsheets", text: "Text", image: "Images",
  video: "Video", archive: "Archives", other: "Other"
};
const SORTS = {
  recent:   { field: "$createdAt", dir: "desc", label: "Recently added" },
  oldest:   { field: "$createdAt", dir: "asc",  label: "Oldest first" },
  az:       { field: "title",      dir: "asc",  label: "Title A–Z" },
  za:       { field: "title",      dir: "desc", label: "Title Z–A" },
  largest:  { field: "fileSize",   dir: "desc", label: "Largest first" },
  smallest: { field: "fileSize",   dir: "asc",  label: "Smallest first" }
};

/* ----------------------------------------------------------------------------
   2. Utilities
---------------------------------------------------------------------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function uid() {
  return "id" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}
function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
function fmtRel(iso) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const day = 86400000;
  if (diff < 3600000) return "just now";
  if (diff < day) return Math.round(diff / 3600000) + "h ago";
  if (diff < 2 * day) return "yesterday";
  if (diff < 30 * day) return Math.round(diff / day) + " days ago";
  if (diff < 365 * day) return Math.round(diff / (30 * day)) + " mo ago";
  return Math.round(diff / (365 * day)) + " yr ago";
}
function longDate(d) {
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}
function initialOf(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "··";
}
function fileCat(fileName, mimeType) {
  const e = extOf(fileName);
  if (EXT_META[e]) return EXT_META[e].cat;
  const m = (mimeType || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("text/")) return "text";
  return "other";
}
function fileLabel(fileName) {
  return EXT_META[extOf(fileName)]?.label || (extOf(fileName) || "file").toUpperCase();
}
function buildSearchText(parts) {
  return parts.filter(Boolean).join(" ").toLowerCase().slice(0, 1900);
}
function icon(name, cls = "ic") {
  return `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

/* Friendly, non-leaking error messages */
function friendlyError(e, fallback) {
  if (e && e.userMessage) return e.userMessage;
  const code = e && (e.code ?? e.status);
  const type = String((e && e.type) || "");
  if (/Failed to fetch|NetworkError|load failed/i.test(String(e && e.message))) {
    return "Cannot reach the backend. Check your connection, the Appwrite endpoint, and that this domain is registered as a Web platform in your Appwrite console.";
  }
  if (type === "user_invalid_credentials") return "Incorrect email or password.";
  if (type === "user_email_already_exists" || type === "user_already_exists") return "An account with that email already exists.";
  if (code === 401 || type === "user_unauthorized" || type === "session_expired") return "Your session has expired. Please sign in again.";
  if (code === 403 || type === "general_access_denied" || type === "user_unauthorized") return "You do not have permission to perform that action.";
  if (code === 404 || type.endsWith("not_found")) return "That item could not be found. It may have been removed.";
  if (code === 409 || type.includes("already_exists")) return "That item already exists.";
  if (code === 429 || type.includes("rate_limit")) return "Too many requests — please wait a moment and try again.";
  if (type === "file_size_limit_exceeded") return "The file exceeds the storage bucket's maximum file size.";
  if (/file_type|extension/i.test(type)) return "That file type is not allowed by the storage bucket.";
  if (type === "document_invalid_structure") return "The record did not match the database schema. Check that all attributes exist.";
  if (type === "query_missing_index" || /index/i.test(type)) return "The database query needs a matching index. See README — Database setup.";
  if (code === 500 || code === 502 || code === 503) return "The backend reported an error. Please try again shortly.";
  return (e && e.message) || fallback || "Something went wrong. Please try again.";
}
function wrapError(e, message) {
  const err = (e instanceof Error) ? e : new Error(String(e));
  err.userMessage = message || friendlyError(e);
  return err;
}

/* ----------------------------------------------------------------------------
   3. DOM references
---------------------------------------------------------------------------- */
const dom = {};
function cacheDom() {
  dom.loginView = $("#login-view");
  dom.configView = $("#config-view");
  dom.shell = $("#shell");
  dom.main = $("#main");
  dom.sidebar = $("#sidebar");
  dom.navIndicator = $("#nav-indicator");
  dom.adminNav = $("#admin-nav");
  dom.navBackdrop = $("#nav-backdrop");
  dom.btnMenu = $("#btn-menu");
  dom.btnSideClose = $("#btn-side-close");
  dom.btnExitPreview = $("#btn-exit-preview");
  dom.previewBanner = $("#preview-banner");
  dom.sideName = $("#side-name");
  dom.sideRole = $("#side-role");
  dom.sideAvatar = $("#side-avatar");
  dom.btnSideLogout = $("#btn-side-logout");
  dom.btnSidePassword = $("#btn-side-password");
  dom.footMeta = $("#foot-meta");
  dom.toasts = $("#toasts");
  dom.announcer = $("#announcer");
  dom.modal = $("#modal");
  dom.fileInput = $("#file-input");
  dom.loginForm = $("#login-form");
  dom.loginEmail = $("#login-email");
  dom.loginPassword = $("#login-password");
  dom.loginAlert = $("#login-alert");
  dom.loginSubmit = $("#login-submit");
  dom.pwToggle = $("#pw-toggle");
  dom.loginYear = $("#login-year");
}

/* ----------------------------------------------------------------------------
   4. Toasts + announcer
---------------------------------------------------------------------------- */
function toast(kind, message, ms = 4200) {
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.innerHTML = `${icon(kind === "success" ? "check" : kind === "error" ? "alert" : "info")}<div>${message}</div>`;
  dom.toasts.appendChild(el);
  const dismiss = () => { el.classList.add("out"); setTimeout(() => el.remove(), 260); };
  el.addEventListener("click", dismiss);
  setTimeout(dismiss, ms);
}
function announce(text) { dom.announcer.textContent = text; }

/* ----------------------------------------------------------------------------
   5. Modal stack (native <dialog>; backdrop clicks never dismiss)
---------------------------------------------------------------------------- */
const modalBlobs = new Set();
function trackBlob(url) { modalBlobs.add(url); return url; }
function revokeModalBlobs() { modalBlobs.forEach(u => URL.revokeObjectURL(u)); modalBlobs.clear(); }

let modalStack = [];
function pushModal(renderFn, opts = {}) {
  dom.modal.classList.toggle("wide", !!opts.wide);
  modalStack.push(renderFn);
  if (!dom.modal.open) dom.modal.showModal();
  renderModalTop();
}
function renderModalTop() {
  const fn = modalStack[modalStack.length - 1];
  if (!fn) return;
  dom.modal.innerHTML = "";
  dom.modal.setAttribute("aria-labelledby", "modal-title");
  fn(dom.modal);
}
function popModal() {
  modalStack.pop();
  if (modalStack.length) renderModalTop();
  else closeModal();
}
function closeModal() {
  modalStack = [];
  if (dom.modal.open) dom.modal.close();
  dom.modal.innerHTML = "";
  revokeModalBlobs();
}
function setupModal() {
  dom.modal.addEventListener("cancel", (e) => { e.preventDefault(); popModal(); });
  dom.modal.addEventListener("click", (e) => {
    if (e.target === dom.modal) { /* deliberate: clicking outside never triggers destructive dismissal */ }
  });
}
function modalHead(kicker, title, tileCat) {
  return `
    <header class="modal-head">
      ${tileCat ? `<span class="tile" data-cat="${esc(tileCat)}">${esc(tileCode(tileCat))}</span>` : ""}
      <div class="modal-title-wrap">
        ${kicker ? `<p class="modal-kicker">${esc(kicker)}</p>` : ""}
        <h2 class="modal-title" id="modal-title">${esc(title)}</h2>
      </div>
      <button class="icon-btn modal-close" type="button" data-close-modal aria-label="Close dialog">${icon("x")}</button>
    </header>`;
}
function bindModalChrome(root) {
  root.querySelector("[data-close-modal]")?.addEventListener("click", () => popModal());
}

/* Confirmation dialog — never dismissed by clicking outside */
function confirmDialog({ title, body, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    pushModal((root) => {
      root.innerHTML = `
        ${modalHead("", title)}
        <div class="modal-body"><p>${body}</p></div>
        <footer class="modal-foot">
          <button class="btn" type="button" data-cd-cancel>${esc(cancelLabel)}</button>
          <button class="btn ${danger ? "btn-danger" : "btn-primary"}" type="button" data-cd-ok>${esc(confirmLabel)}</button>
        </footer>`;
      bindModalChrome(root);
      root.querySelector("[data-cd-cancel]").addEventListener("click", () => { popModal(); resolve(false); });
      root.querySelector("[data-cd-ok]").addEventListener("click", () => { popModal(); resolve(true); });
    });
  });
}

/* ----------------------------------------------------------------------------
   6. Configuration check + configuration screen
---------------------------------------------------------------------------- */
const PLACEHOLDER_RE = /^YOUR_|^$|your-project|replace-me/i;
function configStatus() {
  const required = [
    ["endpoint", FOLIO_CONFIG.endpoint],
    ["projectId", FOLIO_CONFIG.projectId],
    ["databaseId", FOLIO_CONFIG.databaseId],
    ["documentsCollectionId", FOLIO_CONFIG.documentsCollectionId],
    ["subjectsCollectionId", FOLIO_CONFIG.subjectsCollectionId],
    ["storageBucketId", FOLIO_CONFIG.storageBucketId]
  ];
  const missing = required.filter(([, v]) => PLACEHOLDER_RE.test(String(v || "").trim()));
  return { required, missing, ok: missing.length === 0 };
}
function renderConfigScreen(opts = {}) {
  const st = configStatus();
  dom.loginView.hidden = true;
  dom.shell.hidden = true;
  dom.configView.hidden = false;
  const rows = st.required.map(([k, v]) => {
    const bad = PLACEHOLDER_RE.test(String(v || "").trim());
    return `<div class="cfg-row"><span class="cfg-key">${esc(k)}</span><span class="cfg-val ${bad ? "" : "ok"}">${bad ? esc(v || "(empty)") : esc(v)}</span></div>`;
  }).join("");
  const sdkNote = opts.sdkMissing
    ? `<div class="alert alert-error" role="alert">${icon("alert")}<span>The Appwrite Web SDK v${APPWRITE_SDK_VERSION} could not be loaded — neither the bundled <code>appwrite.sdk.js</code> nor the CDN fallback. Make sure <code>appwrite.sdk.js</code> sits next to <code>index.html</code>, then check your network connection or content blockers and reload.</span></div>`
    : "";
  dom.configView.innerHTML = `
    <div class="config-wrap">
      <div class="config-card" data-reveal>
        <div class="config-banner">
          <span class="wordmark wordmark-lg"><svg class="wordmark-mark" aria-hidden="true"><use href="#logo-mark"/></svg><span class="wordmark-text">Folio</span></span>
          <h1>Folio is installed, but not connected yet.</h1>
          <p>Folio talks directly to your Appwrite Cloud project — there is no demo data behind the real app and no server of our own. Open <code>script.js</code>, find <code>FOLIO_CONFIG</code> at the top, and fill in the six values below (every one of them is documented step-by-step in <a href="README.md"><strong>README.md</strong></a>).</p>
        </div>
        <div class="config-body">
          ${sdkNote}
          <p class="kicker">Current configuration</p>
          <div class="cfg-table">${rows}</div>
          <div class="config-steps">
            <div class="config-step"><span class="config-step-num">1</span><h3>Create the project</h3><p>appwrite.io → Console → create a project, then add your host under <em>Platforms → Web app</em> (required for browser access).</p></div>
            <div class="config-step"><span class="config-step-num">2</span><h3>Create the database</h3><p>Five collections: <code>profiles</code>, <code>subjects</code>, <code>documents</code>, <code>document_versions</code>, <code>starred</code> — attributes, indexes and permissions are tabulated in the README.</p></div>
            <div class="config-step"><span class="config-step-num">3</span><h3>Create the storage bucket</h3><p>Private bucket with the academic file-type allowlist. Read for authenticated users, write for the <code>admins</code> team only.</p></div>
            <div class="config-step"><span class="config-step-num">4</span><h3>Provision accounts</h3><p>Run <code>backend/create_user.py</code> on your machine to create the administrator and viewers — there is no public sign-up.</p></div>
            <div class="config-step"><span class="config-step-num">5</span><h3>Enter the IDs &amp; launch</h3><p>Paste the six IDs into <code>FOLIO_CONFIG</code>, serve this folder over HTTP, and sign in.</p></div>
            <div class="config-step"><span class="config-step-num">6</span><h3>Re-check</h3><p>After editing <code>script.js</code>, reload this page. Folio validates the values before connecting.</p></div>
          </div>
          <div class="config-actions">
            <button class="btn" type="button" id="btn-recheck">${icon("refresh")}<span>Re-check configuration</span></button>
            <button class="btn btn-teal" type="button" id="btn-preview-viewer">${icon("user")}<span>Preview as viewer</span></button>
            <button class="btn btn-teal" type="button" id="btn-preview-admin">${icon("key")}<span>Preview as administrator</span></button>
          </div>
          <p class="config-note">The two preview buttons open a clearly-labelled design preview with simulated data — no backend calls, no uploads, nothing persisted. The real application requires the configuration above and never substitutes fake data for a missing backend.</p>
        </div>
      </div>
    </div>`;
  startReveals(dom.configView);
  $("#btn-recheck").addEventListener("click", () => location.reload());
  $("#btn-preview-viewer").addEventListener("click", () => enterDemo("viewer"));
  $("#btn-preview-admin").addEventListener("click", () => enterDemo("admin"));
  announce("Folio needs configuration before it can connect to a backend.");
}

/* ----------------------------------------------------------------------------
   7. DEMO BACKEND — in-memory, clearly labelled, used ONLY for design preview
---------------------------------------------------------------------------- */
function demoApi(role) {
  const delay = (ms = 120) => new Promise(r => setTimeout(r, ms));
  const now = Date.now();
  const daysAgo = (d) => new Date(now - d * 86400000).toISOString();

  const subjects = [
    { id: "mathematics", name: "Mathematics", description: "Algebra, calculus and statistics resources for Terms 1–3.", createdAt: daysAgo(120) },
    { id: "physics", name: "Physics", description: "Mechanics, optics and lab materials for the sciences stream.", createdAt: daysAgo(118) },
    { id: "chemistry", name: "Chemistry", description: "Practicals, reference sheets and reaction summaries.", createdAt: daysAgo(110) },
    { id: "biology", name: "Biology", description: "Diagrams, glossaries and annotated microscope work.", createdAt: daysAgo(104) },
    { id: "history", name: "History & Civics", description: "Source analysis, timelines and essay frameworks.", createdAt: daysAgo(96) },
    { id: "literature", name: "Literature", description: "Poetry anthologies, close-reading notes and essay craft.", createdAt: daysAgo(90) }
  ].map(s => ({ ...s, archived: false }));

  const seed = [
    ["Integration Techniques — Lecture Notes", "mathematics", "pdf", 2516582, 2, ["calculus", "integration", "notes"], "Worked examples covering substitution, integration by parts and partial fractions."],
    ["Past Papers 2024 — Revision Bundle", "mathematics", "zip", 23068672, 1, ["past-papers", "revision"], "Full archive of last year's practice papers with marking schemes."],
    ["Linear Algebra — Problem Set 04", "mathematics", "pdf", 839680, 9, ["linear-algebra", "problems"], "Eigenvectors, diagonalisation and applications."],
    ["Vectors & Scalars — Slide Deck", "physics", "pptx", 6396314, 4, ["vectors", "mechanics"], "Introduction to vector quantities with diagrams and quiz slides."],
    ["Optics Lab Report Template", "physics", "docx", 317440, 21, ["optics", "lab"], "Structured template for the lenses and refraction practical."],
    ["Mechanics Demo Reel", "physics", "mp4", 50331648, 15, ["mechanics", "video"], "Short clips demonstrating collisions and momentum conservation."],
    ["Periodic Table Reference Sheet", "chemistry", "pdf", 1153434, 12, ["periodic-table", "reference"], "Colour-coded groups with electronegativity trends."],
    ["Titration Practical — Method & Data", "chemistry", "xlsx", 245760, 16, ["titration", "practical"], "Recording sheet with embedded calculation formulas."],
    ["Cell Division — Annotated Diagrams", "biology", "png", 3984589, 6, ["mitosis", "diagrams"], "High-resolution mitosis stages with labelled callouts."],
    ["Genetics Vocabulary Builder", "biology", "docx", 194560, 27, ["genetics", "vocabulary"], "Dominant, recessive, genotype — definitions and usage examples."],
    ["Cold War Timeline Workbook", "history", "pdf", 4823449, 8, ["cold-war", "timeline"], "Key events 1945–1991 with source extracts."],
    ["Source Analysis Framework", "history", "docx", 153600, 33, ["sources", "methodology"], "NOP (nature, origin, purpose) scaffolding for document questions."],
    ["Poetry Meter & Form Anthology", "literature", "pdf", 5452595, 3, ["poetry", "meter"], "Iambic, trochaic and free verse examples with commentary."],
    ["Essay Structure Cheat Sheet", "literature", "txt", 12288, 40, ["essays", "writing"], "One-page PEEL paragraph planner."]
  ];
  const docs = seed.map(([title, subjectId, ext, size, d, tags, description], i) => {
    const meta = EXT_META[ext];
    const subject = subjects.find(s => s.id === subjectId);
    const fileName = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "." + ext;
    const iso = daysAgo(d);
    return {
      id: "demo-doc-" + (i + 1),
      title, description, subjectId, subjectName: subject.name,
      fileId: "demo-file-" + (i + 1), fileName,
      mimeType: meta.mime, category: meta.cat, fileSize: size,
      tags, uploadedBy: "demo-admin", uploadedByName: "Dr. Morgan Reyes",
      version: 1, createdAt: iso, $createdAt: iso, updatedAt: iso, $updatedAt: iso,
      searchText: buildSearchText([title, description, subject.name, meta.label, tags.join(" "), fileName])
    };
  });

  let starSeq = 0;
  let stars = role === "viewer" ? new Map([["demo-doc-1", "demo-star-1"], ["demo-doc-11", "demo-star-2"]].map(([k, v]) => [k, { id: v, documentId: k, createdAt: daysAgo(1) }])) : new Map();
  const versions = new Map();

  const user = role === "admin"
    ? { id: "demo-admin", name: "Dr. Morgan Reyes", email: "you@preview.folio", role: "admin" }
    : { id: "demo-viewer", name: "Riley Parker", email: "you@preview.folio", role: "viewer" };

  const disabled = (action) => {
    const err = new Error("Preview mode: " + action + " needs a connected backend.");
    err.userMessage = "Preview mode — " + action + " is not available without a real backend. Configure FOLIO_CONFIG to connect Appwrite.";
    err.demoBlock = true;
    return err;
  };

  function matches(doc, o) {
    if (o.subjectId && doc.subjectId !== o.subjectId) return false;
    if (o.category && doc.category !== o.category) return false;
    if (o.dateFrom && new Date(doc.createdAt) < new Date(o.dateFrom)) return false;
    if (o.search) {
      const terms = o.search.toLowerCase().split(/\s+/).filter(Boolean);
      const hay = doc.searchText;
      if (!terms.every(t => hay.includes(t))) return false;
    }
    return true;
  }
  function sortDocs(arr, sort) {
    const s = SORTS[sort] || SORTS.recent;
    const dir = s.dir === "asc" ? 1 : -1;
    return arr.slice().sort((a, b) => {
      const av = a[s.field] ?? "", bv = b[s.field] ?? "";
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }

  return {
    demo: true,
    async getSessionUser() { await delay(60); return { id: user.id, name: user.name, email: user.email }; },
    async getProfile() { return { email: user.email, displayName: user.name, username: role === "admin" ? "morgan.reyes" : "riley.parker", role }; },
    async getAdminFlag() { return role === "admin"; },
    async login() { throw disabled("Sign-in"); },
    async logout() { return; },
    async changePassword() { throw disabled("Changing your password"); },
    async listSubjects({ includeArchived = false } = {}) {
      await delay(40);
      return subjects.filter(s => includeArchived || !s.archived).map(s => ({ ...s }));
    },
    async createSubject({ name, description }) {
      await delay(120);
      if (subjects.some(s => s.name.toLowerCase() === name.toLowerCase())) {
        throw wrapError(new Error("exists"), "A subject with that name already exists.");
      }
      const s = { id: "demo-subj-" + uid(), name, description: description || "", archived: false, createdAt: new Date().toISOString() };
      subjects.push(s);
      return { ...s };
    },
    async updateSubject(id, patch) {
      await delay(120);
      const s = subjects.find(x => x.id === id);
      if (!s) throw wrapError(new Error("not found"), "Subject not found.");
      Object.assign(s, patch);
      if (patch.name) docs.forEach(d => { if (d.subjectId === id) { d.subjectName = patch.name; d.searchText = buildSearchText([d.title, d.description, patch.name, fileLabel(d.fileName), (d.tags || []).join(" "), d.fileName]); } });
      return { ...s };
    },
    async countDocsForSubject(id) { return docs.filter(d => d.subjectId === id).length; },
    async countAllDocuments() { return docs.length; },
    async listDocuments(o = {}) {
      await delay(90);
      const filtered = sortDocs(docs.filter(d => matches(d, o)), o.sort || "recent");
      const total = filtered.length;
      const offset = Math.max(0, o.offset || 0);
      const limit = o.limit || PAGE_SIZE;
      return { total, docs: filtered.slice(offset, offset + limit).map(d => ({ ...d })) };
    },
    async getDocument(id) {
      const d = docs.find(x => x.id === id);
      if (!d) throw wrapError(new Error("not found"), "That document could not be found.");
      return { ...d };
    },
    async listDocumentsByIds(ids) {
      const set = new Set(ids);
      return docs.filter(d => set.has(d.id)).map(d => ({ ...d }));
    },
    async createDocument(payload) {
      await delay(140);
      const doc = { id: "demo-doc-" + uid(), ...payload, uploadedByName: user.name, version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      docs.unshift(doc);
      return { ...doc };
    },
    async updateDocument(id, patch) {
      await delay(120);
      const d = docs.find(x => x.id === id);
      if (!d) throw wrapError(new Error("not found"), "Document not found.");
      Object.assign(d, patch, { updatedAt: new Date().toISOString() });
      d.searchText = buildSearchText([d.title, d.description, d.subjectName, fileLabel(d.fileName), (d.tags || []).join(" "), d.fileName]);
      return { ...d };
    },
    async deleteDocument(id) {
      const i = docs.findIndex(x => x.id === id);
      if (i >= 0) docs.splice(i, 1);
      versions.delete(id);
      stars.delete(id);
    },
    async uploadFile() { throw disabled("Uploading files"); },
    async deleteFile() { /* nothing stored in preview */ },
    async downloadBlob() { throw disabled("Downloading"); },
    downloadUrl() { throw disabled("Downloading"); },
    async fileBlob() { throw disabled("Previewing files"); },
    async listVersions(documentId) {
      await delay(60);
      return (versions.get(documentId) || []).slice().sort((a, b) => b.versionNumber - a.versionNumber).map(v => ({ ...v }));
    },
    async createVersion(payload) {
      const list = versions.get(payload.documentId) || [];
      const v = { id: "demo-ver-" + uid(), createdAt: new Date().toISOString(), ...payload };
      list.push(v);
      versions.set(payload.documentId, list);
      return { ...v };
    },
    async deleteVersion(documentId, versionId) {
      const list = (versions.get(documentId) || []).filter(v => v.id !== versionId);
      versions.set(documentId, list);
    },
    async listStars() { await delay(60); return Array.from(stars.values()).map(s => ({ ...s })); },
    async addStar(documentId) {
      if (stars.has(documentId)) return stars.get(documentId);
      const rec = { id: "demo-star-" + (++starSeq), documentId, createdAt: new Date().toISOString() };
      stars.set(documentId, rec);
      return { ...rec };
    },
    async removeStar(starId) {
      for (const [k, v] of stars) if (v.id === starId) stars.delete(k);
    }
  };
}

/* ----------------------------------------------------------------------------
   8. REAL BACKEND — Appwrite Web SDK (pinned v11.0.0 IIFE build)
---------------------------------------------------------------------------- */
function createRealApi() {
  const { Client, Account, Databases, Storage, Query, ID, Permission, Role } = window.Appwrite;
  const cfg = FOLIO_CONFIG, adv = FOLIO_ADVANCED;
  const client = new Client().setEndpoint(cfg.endpoint).setProject(cfg.projectId);
  const account = new Account(client);
  const databases = new Databases(client);
  const storage = new Storage(client);

  const normDoc = (d) => ({
    id: d.$id, title: d.title, description: d.description || "",
    subjectId: d.subjectId, subjectName: d.subjectName || "",
    fileId: d.fileId, fileName: d.fileName, mimeType: d.mimeType,
    category: d.category || fileCat(d.fileName, d.mimeType),
    fileSize: d.fileSize || 0, tags: d.tags || [],
    uploadedBy: d.uploadedBy || "", uploadedByName: d.uploadedByName || "",
    version: d.version || 1,
    createdAt: d.$createdAt, updatedAt: d.$updatedAt
  });
  const normSubject = (s) => ({ id: s.$id, name: s.name, description: s.description || "", archived: !!s.archived, createdAt: s.$createdAt });
  const normVersion = (v) => ({ id: v.$id, documentId: v.documentId, fileId: v.fileId, fileName: v.fileName, mimeType: v.mimeType, fileSize: v.fileSize, versionNumber: v.versionNumber, changeNote: v.changeNote || "", createdBy: v.createdBy || "", createdAt: v.$createdAt });
  const normStar = (s) => ({ id: s.$id, documentId: s.documentId, createdAt: s.$createdAt });

  async function listAll(collectionId, queries, normalizer, cap = 500) {
    const out = [];
    let offset = 0;
    while (true) {
      const res = await databases.listDocuments(cfg.databaseId, collectionId, [...queries, Query.limit(100), Query.offset(offset)]);
      res.documents.forEach(d => out.push(normalizer(d)));
      if (res.documents.length < 100 || out.length >= cap) break;
      offset += 100;
    }
    return out;
  }

  return {
    demo: false,
    async getSessionUser() {
      const u = await account.get();
      return { id: u.$id || u.id, name: u.name || "", email: u.email || "" };
    },
    async getProfile(userId) {
      try {
        const d = await databases.getDocument(cfg.databaseId, adv.profilesCollectionId, userId);
        return { email: d.email || "", displayName: d.displayName || "", username: d.username || "", role: d.role || "viewer" };
      } catch {
        return { email: "", displayName: "", username: "", role: "viewer" };
      }
    },
    /* Trusted, server-verified administrator check: Appwrite confirms team
       membership; a viewer receives an error, which we treat as "not admin". */
    async getAdminFlag() {
      try {
        const res = await account.listMemberships(adv.adminTeamId);
        return (res.total || 0) > 0;
      } catch (e) {
        if (e && (e.code === 401 || e.type === "session_expired" || e.type === "user_unauthorized")) throw e;
        return false;
      }
    },
    async login(email, password) {
      if (typeof account.createEmailPasswordSession === "function") {
        await account.createEmailPasswordSession(email, password);
      } else if (typeof account.createEmailSession === "function") {
        await account.createEmailSession(email, password); // SDK < 11 compatibility
      } else {
        throw wrapError(new Error("SDK missing session method"), "The loaded Appwrite SDK does not support email sessions.");
      }
    },
    async logout() { try { await account.deleteSessions(); } catch { /* session already gone */ } },
    async changePassword(currentPassword, newPassword) {
      await account.updatePassword(newPassword, currentPassword);
    },
    async listSubjects({ includeArchived = false } = {}) {
      const list = await listAll(cfg.subjectsCollectionId, [Query.orderAsc("name")], normSubject, 200);
      return includeArchived ? list : list.filter(s => !s.archived);
    },
    async createSubject({ name, description }) {
      const d = await databases.createDocument(cfg.databaseId, cfg.subjectsCollectionId, ID.unique(), {
        name, description: description || "", archived: false
      });
      return normSubject(d);
    },
    async updateSubject(id, patch) {
      const data = {};
      if (patch.name !== undefined) data.name = patch.name;
      if (patch.description !== undefined) data.description = patch.description;
      if (patch.archived !== undefined) data.archived = patch.archived;
      const d = await databases.updateDocument(cfg.databaseId, cfg.subjectsCollectionId, id, data);
      /* Keep denormalised subject names on documents in sync after a rename. */
      if (patch.name) {
        try {
          let offset = 0;
          while (offset < 1000) {
            const page = await databases.listDocuments(cfg.databaseId, cfg.documentsCollectionId, [Query.equal("subjectId", id), Query.limit(100), Query.offset(offset)]);
            for (const doc of page.documents) {
              const nd = normDoc(doc);
              await databases.updateDocument(cfg.databaseId, cfg.documentsCollectionId, nd.id, {
                subjectName: patch.name,
                searchText: buildSearchText([nd.title, nd.description, patch.name, fileLabel(nd.fileName), (nd.tags || []).join(" "), nd.fileName])
              });
            }
            if (page.documents.length < 100) break;
            offset += 100;
          }
        } catch { /* non-fatal: names refresh on next edit */ }
      }
      return normSubject(d);
    },
    async countDocsForSubject(subjectId) {
      const res = await databases.listDocuments(cfg.databaseId, cfg.documentsCollectionId, [Query.equal("subjectId", subjectId), Query.limit(1)]);
      return res.total || 0;
    },
    async countAllDocuments() {
      const res = await databases.listDocuments(cfg.databaseId, cfg.documentsCollectionId, [Query.limit(1)]);
      return res.total || 0;
    },
    async listDocuments(o = {}) {
      const q = [];
      if (o.search) q.push(Query.search("searchText", o.search.trim()));
      if (o.subjectId) q.push(Query.equal("subjectId", o.subjectId));
      if (o.category) q.push(Query.equal("category", o.category));
      if (o.dateFrom) q.push(Query.greaterThanEqual("$createdAt", o.dateFrom));
      const s = SORTS[o.sort] || SORTS.recent;
      q.push(s.dir === "asc" ? Query.orderAsc(s.field) : Query.orderDesc(s.field));
      q.push(Query.limit(o.limit || PAGE_SIZE));
      if (o.offset) q.push(Query.offset(o.offset));
      const res = await databases.listDocuments(cfg.databaseId, cfg.documentsCollectionId, q);
      return { total: res.total || 0, docs: res.documents.map(normDoc) };
    },
    async getDocument(id) {
      const d = await databases.getDocument(cfg.databaseId, cfg.documentsCollectionId, id);
      return normDoc(d);
    },
    async listDocumentsByIds(ids) {
      const out = [];
      for (const chunk of chunkArr(ids, 100)) {
        const res = await databases.listDocuments(cfg.databaseId, cfg.documentsCollectionId, [Query.equal("$id", chunk), Query.limit(100)]);
        res.documents.forEach(d => out.push(normDoc(d)));
      }
      return out;
    },
    async createDocument(p) {
      const d = await databases.createDocument(cfg.databaseId, cfg.documentsCollectionId, ID.unique(), {
        title: p.title, description: p.description || "", subjectId: p.subjectId, subjectName: p.subjectName || "",
        fileId: p.fileId, fileName: p.fileName, mimeType: p.mimeType, category: p.category,
        fileSize: p.fileSize, tags: p.tags || [], uploadedBy: p.uploadedBy, uploadedByName: p.uploadedByName || "",
        version: 1, searchText: p.searchText
      });
      return normDoc(d);
    },
    async updateDocument(id, patch) {
      const data = {};
      const keys = ["title", "description", "subjectId", "subjectName", "fileId", "fileName", "mimeType", "category", "fileSize", "version", "searchText", "tags", "uploadedByName"];
      keys.forEach(k => { if (patch[k] !== undefined) data[k] = patch[k]; });
      const d = await databases.updateDocument(cfg.databaseId, cfg.documentsCollectionId, id, data);
      return normDoc(d);
    },
    async deleteDocument(id) {
      await databases.deleteDocument(cfg.databaseId, cfg.documentsCollectionId, id);
    },
    /* Chunked upload with real progress events (SDK 11 exposes onProgress). */
    uploadFile(file, onProgress) {
      const fileId = ID.unique();
      const promise = storage.createFile(cfg.storageBucketId, fileId, file, [], (p) => {
        if (typeof onProgress === "function") {
          const pct = Math.max(0, Math.min(100, Math.round(p && p.progress != null ? p.progress : 0)));
          onProgress(pct, p);
        }
      });
      return { fileId, promise };
    },
    async deleteFile(fileId) {
      try { await storage.deleteFile(cfg.storageBucketId, fileId); } catch { /* already gone */ }
    },
    async downloadBlob(fileId) {
      const url = storage.getFileDownload(cfg.storageBucketId, fileId);
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw wrapError(new Error("download failed"), "The backend refused the download (" + res.status + ").");
      return await res.blob();
    },
    downloadUrl(fileId) {
      return storage.getFileDownload(cfg.storageBucketId, fileId);
    },
    async fileBlob(fileId) {
      const url = storage.getFileView(cfg.storageBucketId, fileId);
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw wrapError(new Error("view failed"), "The backend refused the preview (" + res.status + ").");
      return await res.blob();
    },
    async listVersions(documentId) {
      return listAll(adv.versionsCollectionId, [Query.equal("documentId", documentId), Query.orderDesc("versionNumber")], normVersion, 200);
    },
    async createVersion(p) {
      const d = await databases.createDocument(cfg.databaseId, adv.versionsCollectionId, ID.unique(), {
        documentId: p.documentId, fileId: p.fileId, fileName: p.fileName, mimeType: p.mimeType,
        fileSize: p.fileSize, versionNumber: p.versionNumber, changeNote: p.changeNote || "", createdBy: p.createdBy || ""
      });
      return normVersion(d);
    },
    async deleteVersion(versionId, fileId) {
      await databases.deleteDocument(cfg.databaseId, adv.versionsCollectionId, versionId);
      if (fileId) await this.deleteFile(fileId);
    },
    async listStars() {
      const u = await account.get();
      const uid = u.$id || u.id;
      return listAll(adv.starredCollectionId, [Query.equal("userId", uid)], normStar, 500);
    },
    async addStar(documentId) {
      const u = await account.get();
      const uid = u.$id || u.id;
      const perms = [
        Permission.read(Role.user(uid)),
        Permission.update(Role.user(uid)),
        Permission.delete(Role.user(uid))
      ];
      const d = await databases.createDocument(cfg.databaseId, adv.starredCollectionId, ID.unique(),
        { userId: uid, documentId }, perms);
      return normStar(d);
    },
    async removeStar(starId) {
      await databases.deleteDocument(cfg.databaseId, adv.starredCollectionId, starId);
    }
  };
}

/* ----------------------------------------------------------------------------
   9. Application state
---------------------------------------------------------------------------- */
const state = {
  api: null,            // active backend (real or demo)
  demo: false,
  user: null,           // { id, name, email }
  profile: null,        // { email, displayName, username, role }
  isAdmin: false,
  subjects: [],         // non-archived subjects
  allSubjects: [],
  stars: new Map(),     // documentId -> star record
  filters: { q: "", subject: "", type: "", date: "", sort: "recent", view: "list", page: 1 },
  adminDocs: { q: "", subject: "", sort: "recent", page: 1 },
  queue: [],
  uploading: false,
  filePickerMode: "upload",
  replaceContext: null,
  reqToken: 0
};

function saveFilterPrefs() {
  try { localStorage.setItem("folio.prefs", JSON.stringify({ view: state.filters.view })); } catch { /* harmless pref */ }
}
function loadFilterPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem("folio.prefs") || "{}");
    if (p.view === "grid" || p.view === "list") state.filters.view = p.view;
  } catch { /* ignore */ }
}

/* ----------------------------------------------------------------------------
   10. Session + auth flows
---------------------------------------------------------------------------- */
async function loadSessionData() {
  state.user = await state.api.getSessionUser();
  state.profile = await state.api.getProfile(state.user.id);
  state.isAdmin = await state.api.getAdminFlag();
  const [subjects, allSubjects, stars] = await Promise.all([
    state.api.listSubjects(),
    state.api.listSubjects({ includeArchived: true }),
    state.api.listStars().catch(() => [])
  ]);
  state.subjects = subjects;
  state.allSubjects = allSubjects;
  state.stars = new Map(stars.map(s => [s.documentId, s]));
  paintAccountChrome();
}

function paintAccountChrome() {
  const name = state.profile?.displayName || state.user?.name || "Member";
  dom.sideName.textContent = name;
  dom.sideAvatar.textContent = initialOf(name);
  const role = state.isAdmin ? "Administrator" : (state.profile?.role === "admin" ? "Administrator" : "Viewer");
  dom.sideRole.textContent = role;
  dom.sideRole.className = "role-badge" + (state.isAdmin || state.profile?.role === "admin" ? " role-admin" : "");
  dom.adminNav.hidden = !state.isAdmin;
  dom.footMeta.textContent = state.demo ? "Preview mode · simulated data" : `Signed in · ${role.toLowerCase()}`;
  dom.previewBanner.hidden = !state.demo;
}

function showLogin() {
  dom.configView.hidden = true;
  dom.shell.hidden = true;
  dom.loginView.hidden = false;
  dom.loginAlert.hidden = true;
  dom.loginPassword.value = "";
  startReveals(dom.loginView);
  setTimeout(() => dom.loginEmail.focus(), 80);
  document.title = "Folio — Sign in";
}

async function doLogin(e) {
  e.preventDefault();
  dom.loginAlert.hidden = true;
  const email = dom.loginEmail.value.trim();
  const password = dom.loginPassword.value;
  let ok = true;
  ok = setFieldError(dom.loginEmail, "login-email-err", /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? "" : "Enter a valid email address.") && ok;
  ok = setFieldError(dom.loginPassword, "login-password-err", password ? "" : "Enter your password.") && ok;
  if (!ok) return;
  dom.loginSubmit.classList.add("is-loading");
  dom.loginSubmit.setAttribute("aria-busy", "true");
  try {
    await state.api.login(email, password);
    await loadSessionData();
    dom.loginView.hidden = true;
    dom.shell.hidden = false;
    const dest = "#/dashboard";
    if (location.hash === dest) route(); else location.hash = dest;
    toast("success", `Welcome back, <strong>${esc(state.profile?.displayName || state.user.name)}</strong>.`);
  } catch (err) {
    dom.loginAlert.innerHTML = `${icon("alert")}<span>${esc(friendlyError(err, "Sign-in failed. Please check your details and try again."))}</span>`;
    dom.loginAlert.hidden = false;
    dom.loginPassword.value = "";
    dom.loginPassword.focus();
  } finally {
    dom.loginSubmit.classList.remove("is-loading");
    dom.loginSubmit.removeAttribute("aria-busy");
  }
}
function setFieldError(input, errId, message) {
  const el = document.getElementById(errId);
  if (message) { input.setAttribute("aria-invalid", "true"); if (el) { el.textContent = message; el.hidden = false; } return false; }
  input.removeAttribute("aria-invalid"); if (el) el.hidden = true;
  return true;
}

async function doLogout() {
  try { await state.api.logout(); } catch { /* best effort */ }
  if (state.demo) { exitDemo(); return; }
  resetAppState();
  dom.shell.hidden = true;
  showLogin();
  toast("info", "You have been signed out.");
}
function resetAppState() {
  state.user = null; state.profile = null; state.isAdmin = false;
  state.subjects = []; state.allSubjects = []; state.stars = new Map();
  state.queue = []; state.uploading = false;
  state.filters = { q: "", subject: "", type: "", date: "", sort: "recent", view: state.filters.view, page: 1 };
}
function sessionExpired() {
  resetAppState();
  if (state.demo) { exitDemo(); return; }
  dom.shell.hidden = true;
  showLogin();
  toast("error", "Your session has expired. Please sign in again.");
}
function handleApiError(e, contextMessage) {
  const code = e && e.code;
  const type = String((e && e.type) || "");
  if (code === 401 || type === "session_expired" || type === "user_unauthorized") { sessionExpired(); return true; }
  toast("error", esc(friendlyError(e, contextMessage)));
  return false;
}
function demoBlocked(e) { return !!(e && e.demoBlock); }

/* Preview mode entry / exit */
function enterDemo(role) {
  state.api = demoApi(role);
  state.demo = true;
  state.user = null;
  loadSessionData().then(() => {
    dom.configView.hidden = true;
    dom.loginView.hidden = true;
    dom.shell.hidden = false;
    if (!location.hash.startsWith("#/dashboard")) location.hash = "#/dashboard";
    else route();
    toast("info", `<strong>Preview mode</strong> — simulated data, nothing is stored or uploaded.`);
  }).catch((e) => { console.error(e); toast("error", "Preview failed to start."); });
}
function exitDemo() {
  state.api = null;
  state.demo = false;
  resetAppState();
  dom.shell.hidden = true;
  renderConfigScreen();
}

/* ----------------------------------------------------------------------------
   11. Router
---------------------------------------------------------------------------- */
const TITLES = {
  dashboard: "Dashboard", library: "Resource Library", subjects: "Subjects",
  recent: "Recently Added", starred: "Starred", settings: "Settings",
  admin: "Administrator", subject: "Subject", login: "Sign in"
};
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [pathStr, queryStr] = raw.split("?");
  return { segs: pathStr.split("/").filter(Boolean), params: new URLSearchParams(queryStr || "") };
}
function navKeyFor(segs) {
  if (!segs.length || segs[0] === "dashboard") return "dashboard";
  if (segs[0] === "library") return "library";
  if (segs[0] === "subjects" || segs[0] === "subject") return "subjects";
  if (segs[0] === "recent") return "recent";
  if (segs[0] === "starred") return "starred";
  if (segs[0] === "settings") return "settings";
  if (segs[0] === "admin") return "admin-" + (segs[1] || "upload");
  return "dashboard";
}
async function route() {
  if (!state.user) { showLogin(); return; }
  const { segs, params } = parseHash();
  const key = navKeyFor(segs);
  setActiveNav(key);
  try {
    if (!segs.length || segs[0] === "dashboard") await viewDashboard();
    else if (segs[0] === "library") await viewLibrary(params);
    else if (segs[0] === "subjects") await viewSubjectsIndex();
    else if (segs[0] === "subject" && segs[1]) await viewSubjectPage(decodeURIComponent(segs[1]));
    else if (segs[0] === "recent") await viewRecent();
    else if (segs[0] === "starred") await viewStarred();
    else if (segs[0] === "settings") viewSettings();
    else if (segs[0] === "admin") {
      if (!state.isAdmin) {
        toast("error", "Administrator access is required for that section.");
        location.hash = "#/dashboard";
        return;
      }
      await viewAdmin(segs[1] || "upload");
    }
    else await viewDashboard();
  } catch (e) {
    if (demoBlocked(e)) { toast("info", esc(e.userMessage)); return; }
    if (!handleApiError(e, "This view failed to load.")) {
      dom.main.innerHTML = `
        <div class="empty">
          <div class="empty-art">${emptyArt("error")}</div>
          <p class="empty-title">Something went wrong</p>
          <p class="empty-desc">${esc(friendlyError(e, "The view could not be rendered."))}</p>
          <div class="empty-actions"><button class="btn btn-teal" type="button" onclick="location.reload()">Reload Folio</button></div>
        </div>`;
    }
  }
  window.scrollTo({ top: 0, behavior: REDUCED ? "auto" : "smooth" });
  dom.main.focus({ preventScroll: true });
}
function setActiveNav(key) {
  $$(".nav-item", dom.sidebar).forEach(a => a.classList.toggle("active", a.dataset.nav === key));
  positionIndicator();
}
function positionIndicator() {
  const active = $(".nav-item.active", dom.sidebar);
  if (!active) { dom.navIndicator.style.opacity = "0"; return; }
  const nav = $(".side-nav", dom.sidebar);
  const top = active.offsetTop, h = active.offsetHeight;
  dom.navIndicator.style.opacity = "1";
  if (dom.navIndicator.style.top === "" ) {
    dom.navIndicator.style.transition = "none";
    dom.navIndicator.style.top = top + "px"; dom.navIndicator.style.height = h + "px";
    requestAnimationFrame(() => { dom.navIndicator.style.transition = ""; });
  } else {
    dom.navIndicator.style.top = top + "px";
    dom.navIndicator.style.height = h + "px";
  }
}

/* ----------------------------------------------------------------------------
   12. Reveal + count-up animation helpers
---------------------------------------------------------------------------- */
const revealObserver = ("IntersectionObserver" in window) && !REDUCED
  ? new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) { en.target.classList.add("reveal-in"); revealObserver.unobserve(en.target); }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 })
  : null;

function startReveals(root) {
  const els = $$("[data-reveal], .reveal-scale", root);
  els.forEach((el, i) => {
    if (!el.style.getPropertyValue("--d")) el.style.setProperty("--d", Math.min(i, 9) * 55 + "ms");
    if (REDUCED || !revealObserver || i < 10) {
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("reveal-in")));
    } else {
      revealObserver.observe(el);
    }
  });
}
function countUp(el, target) {
  const value = Number(target) || 0;
  if (REDUCED) { el.textContent = String(value); return; }
  const start = performance.now(), dur = 720;
  function frame(t) {
    const p = Math.min(1, (t - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = String(Math.round(value * eased));
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/* ----------------------------------------------------------------------------
   13. Shared document rendering
---------------------------------------------------------------------------- */
function docMetaLine(d) {
  return `${esc(fileLabel(d.fileName))} · ${esc(fmtBytes(d.fileSize))} · added ${esc(fmtRel(d.createdAt))}`;
}
const CATEGORY_CODES = { pdf: "PDF", document: "DOC", presentation: "PPT", spreadsheet: "XLS", text: "TXT", image: "IMG", video: "VID", archive: "ZIP", other: "FILE" };
function tileCode(cat) {
  return CATEGORY_CODES[cat] || "FILE";
}
function starBtnHtml(d) {
  const starred = state.stars.has(d.id);
  return `<button class="star-btn ${starred ? "is-starred" : ""}" data-star="${esc(d.id)}" type="button"
    aria-pressed="${starred}" aria-label="${starred ? "Remove from starred" : "Add to starred"}">${icon(starred ? "star-fill" : "star")}</button>`;
}
function adminRowActions() {
  if (!state.isAdmin) return "";
  return `
    <button class="row-act" data-edit-doc title="Edit details" aria-label="Edit document details">${icon("edit")}</button>
    <button class="row-act danger" data-del-doc title="Delete" aria-label="Delete document">${icon("trash")}</button>`;
}
function rowHtml(d, opts = {}) {
  return `
  <article class="doc-row" data-doc="${esc(d.id)}" data-reveal>
    <span class="tile" data-cat="${esc(d.category)}" aria-hidden="true">${esc(tileCode(d.category))}</span>
    <div class="doc-main">
      <span class="doc-kicker">${esc(d.subjectName || "Unassigned")}</span>
      <div class="doc-title-row">
        <button class="doc-title" data-open="${esc(d.id)}" type="button">${esc(d.title)}</button>
      </div>
      <p class="doc-meta">${docMetaLine(d)}</p>
      ${d.description ? `<p class="doc-desc">${esc(d.description)}</p>` : ""}
      ${(d.tags && d.tags.length) ? `<div class="doc-tags">${d.tags.slice(0, 4).map(t => `<span class="chip chip-teal">${esc(t)}</span>`).join("")}</div>` : ""}
    </div>
    <div class="row-actions">
      ${adminRowActions()}
      ${starBtnHtml(d)}
    </div>
  </article>`;
}
function cardHtml(d) {
  const starred = state.stars.has(d.id);
  return `
  <article class="doc-card" data-doc="${esc(d.id)}" data-reveal>
    <div class="card-tile" data-pattern="${(d.title.length % 6) + 1}">
      <span class="tile" data-cat="${esc(d.category)}" aria-hidden="true">${esc(tileCode(d.category))}</span>
      <span class="card-type">${esc(fileLabel(d.fileName))} · ${esc(fmtBytes(d.fileSize))}</span>
    </div>
    <div class="doc-card-body">
      <span class="doc-kicker">${esc(d.subjectName || "Unassigned")}</span>
      <button class="doc-title" data-open="${esc(d.id)}" type="button">${esc(d.title)}</button>
      <p class="doc-meta">${esc(fmtRel(d.createdAt))}</p>
      <div class="doc-card-foot">
        <span class="doc-meta">${esc(d.category === "other" ? "File" : CATEGORY_LABELS[d.category] || "File")}</span>
        <div class="row-actions">${adminRowActions()}${starBtnHtml(d)}</div>
      </div>
    </div>
  </article>`;
}
function renderDocResults(container, { docs, total, page, pages }, opts = {}) {
  const view = opts.view || "list";
  if (!docs.length) {
    container.innerHTML = `
      <div class="empty">
        <div class="empty-art">${emptyArt(opts.emptyKind || "noDocs")}</div>
        <p class="empty-title">${esc(opts.emptyTitle || "No documents found")}</p>
        <p class="empty-desc">${esc(opts.emptyDesc || "Try a different search, or clear the filters to browse everything.")}</p>
        ${opts.emptyActions || ""}
      </div>`;
    return;
  }
  container.innerHTML = view === "grid"
    ? `<div class="doc-grid">${docs.map(cardHtml).join("")}</div>`
    : `<div class="doc-list">${docs.map(d => rowHtml(d)).join("")}</div>`;
  if (opts.paginationEl) {
    opts.paginationEl.innerHTML = total > 0 ? paginationHtml(page, pages, total) : "";
  }
  startReveals(container);
}
function paginationHtml(page, pages, total) {
  let btns = "";
  const window_ = [];
  for (let p = 1; p <= pages; p++) {
    if (p === 1 || p === pages || Math.abs(p - page) <= 1) window_.push(p);
  }
  let last = 0;
  for (const p of window_) {
    if (p - last > 1) btns += `<span class="page-info">…</span>`;
    btns += `<button class="page-btn ${p === page ? "active" : ""}" type="button" data-page="${p}" ${p === page ? 'aria-current="page"' : ""}>${p}</button>`;
    last = p;
  }
  return `
    <button class="page-btn" type="button" data-page="prev" ${page <= 1 ? "disabled" : ""} aria-label="Previous page">‹</button>
    ${btns}
    <button class="page-btn" type="button" data-page="next" ${page >= pages ? "disabled" : ""} aria-label="Next page">›</button>
    <span class="page-info">Page ${page} of ${pages} · ${total} document${total === 1 ? "" : "s"}</span>`;
}
function bindDocListEvents(root, { onChange = null, onOpen = null } = {}) {
  root.addEventListener("click", (e) => {
    const open = e.target.closest("[data-open]");
    if (open) { openDocModal(open.dataset.open); return; }
    const star = e.target.closest("[data-star]");
    if (star) { toggleStar(star.dataset.star); return; }
    const edit = e.target.closest("[data-edit-doc]");
    if (edit) {
      const id = edit.closest("[data-doc]").dataset.doc;
      openDocModal(id, "edit");
      return;
    }
    const del = e.target.closest("[data-del-doc]");
    if (del) {
      const id = del.closest("[data-doc]").dataset.doc;
      deleteDocumentFlow(id);
      return;
    }
    const pageBtn = e.target.closest("[data-page]");
    if (pageBtn && !pageBtn.disabled) { if (onChange) onChange(pageBtn.dataset.page); return; }
    if (!e.target.closest("button") && onOpen) {
      const row = e.target.closest("[data-doc]");
      if (row) onOpen(row.dataset.doc);
    }
  });
}

/* ----------------------------------------------------------------------------
   14. Empty-state artwork (original, restrained)
---------------------------------------------------------------------------- */
function emptyArt(kind) {
  const svg = (inner, vb = "0 0 120 96") => `<svg width="120" height="96" viewBox="${vb}" fill="none" aria-hidden="true">${inner}</svg>`;
  if (kind === "noResults") return svg(`
    <circle cx="52" cy="42" r="24" stroke="#1B8C88" stroke-width="3"/>
    <path d="M70 60l22 22" stroke="#56000F" stroke-width="4" stroke-linecap="round"/>
    <path d="M40 40c2-8 9-14 17-14" stroke="#CFC5A9" stroke-width="3" stroke-linecap="round"/>
    <circle cx="98" cy="20" r="3" fill="#E10823"/>`);
  if (kind === "noStars") return svg(`
    <path d="M60 18l10 20 22 3-16 15 4 22-20-11-20 11 4-22-16-15 22-3z" stroke="#E10823" stroke-width="3" stroke-linejoin="round"/>
    <path d="M14 78c10 6 24 9 34 8M104 30c2 8 2 16-1 24" stroke="#CFC5A9" stroke-width="3" stroke-linecap="round"/>`);
  if (kind === "noSubjects") return svg(`
    <path d="M14 30a6 6 0 0 1 6-6h18l7 9h37a6 6 0 0 1 6 6v33a6 6 0 0 1-6 6H20a6 6 0 0 1-6-6z" stroke="#1B8C88" stroke-width="3" stroke-linejoin="round"/>
    <path d="M54 52v14M47 59h14" stroke="#E10823" stroke-width="3.5" stroke-linecap="round"/>`);
  if (kind === "error") return svg(`
    <circle cx="60" cy="46" r="30" stroke="#E10823" stroke-width="3"/>
    <path d="M60 32v18" stroke="#E10823" stroke-width="4" stroke-linecap="round"/>
    <circle cx="60" cy="58" r="2.6" fill="#E10823"/>
    <path d="M18 78c14 8 70 8 84 0" stroke="#CFC5A9" stroke-width="3" stroke-linecap="round"/>`);
  if (kind === "offline") return svg(`
    <path d="M20 62h80" stroke="#CFC5A9" stroke-width="3" stroke-linecap="round"/>
    <path d="M38 62c-6-22 10-40 32-36" stroke="#1B8C88" stroke-width="3" stroke-linecap="round"/>
    <path d="M70 26l14 36" stroke="#56000F" stroke-width="3" stroke-linecap="round"/>
    <path d="M92 40l8-10" stroke="#E10823" stroke-width="3" stroke-linecap="round"/>`);
  /* noDocs */
  return svg(`
    <path d="M22 30a6 6 0 0 1 6-6h18l7 9h35a6 6 0 0 1 6 6v31a6 6 0 0 1-6 6H28a6 6 0 0 1-6-6z" stroke="#1B8C88" stroke-width="3" stroke-linejoin="round"/>
    <circle cx="52" cy="58" r="7" fill="#E10823"/>
    <circle cx="70" cy="62" r="5.5" fill="#9A001A"/>
    <path d="M52 51c1-5 3-7 7-8M70 57c0-4 1-6-1-9" stroke="#335415" stroke-width="2.4" stroke-linecap="round"/>`);
}

/* ----------------------------------------------------------------------------
   15. Sidebar + mobile navigation
---------------------------------------------------------------------------- */
function openNav() {
  dom.shell.classList.add("nav-open");
  dom.navBackdrop.hidden = false;
  dom.btnMenu.setAttribute("aria-expanded", "true");
}
function closeNav() {
  dom.shell.classList.remove("nav-open");
  dom.navBackdrop.hidden = true;
  dom.btnMenu.setAttribute("aria-expanded", "false");
}
function bindShell() {
  dom.btnMenu.addEventListener("click", openNav);
  dom.btnSideClose.addEventListener("click", closeNav);
  dom.navBackdrop.addEventListener("click", closeNav);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dom.shell.classList.contains("nav-open")) closeNav();
  });
  $$(".nav-item", dom.sidebar).forEach(a => a.addEventListener("click", () => closeNav()));
  dom.btnSideLogout.addEventListener("click", doLogout);
  dom.btnSidePassword.addEventListener("click", () => { location.hash = "#/settings"; closeNav(); });
  dom.btnExitPreview.addEventListener("click", exitDemo);
  const debouncedReposition = debounce(positionIndicator, 120);
  window.addEventListener("resize", debouncedReposition);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(positionIndicator);
}

/* ----------------------------------------------------------------------------
   16. Stars
---------------------------------------------------------------------------- */
async function toggleStar(docId) {
  const btns = $$(`[data-star="${docId}"]`);
  const wasStarred = state.stars.has(docId);
  const paint = () => {
    const starred = state.stars.has(docId);
    btns.forEach(b => {
      b.classList.toggle("is-starred", starred);
      b.setAttribute("aria-pressed", String(starred));
      b.setAttribute("aria-label", starred ? "Remove from starred" : "Add to starred");
      b.innerHTML = icon(starred ? "star-fill" : "star");
    });
  };
  if (wasStarred) {
    const rec = state.stars.get(docId);
    state.stars.delete(docId); paint();
    try { await state.api.removeStar(rec.id); }
    catch (e) { state.stars.set(docId, rec); paint(); handleApiError(e, "Could not update your starred list."); return; }
    if (navKeyFor(parseHash().segs) === "starred") route();
  } else {
    state.stars.set(docId, { id: "pending", documentId: docId, createdAt: new Date().toISOString() }); paint();
    try {
      const rec = await state.api.addStar(docId);
      state.stars.set(docId, rec); paint();
      toast("success", "Added to your starred list.");
    } catch (e) {
      state.stars.delete(docId); paint();
      handleApiError(e, "Could not save this star. Please try again.");
      return;
    }
  }
  announce(wasStarred ? "Removed from starred." : "Added to starred.");
}

/* ----------------------------------------------------------------------------
   17. Views — dashboard
---------------------------------------------------------------------------- */
async function viewDashboard() {
  document.title = "Folio — Dashboard";
  state.reqToken++;
  const token = state.reqToken;
  dom.main.innerHTML = `<div class="loading-block"><span class="spinner"></span>Preparing your library…</div>`;
  const name = state.profile?.displayName || state.user?.name || "";
  const hour = new Date().getHours();
  const part = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  let totalDocs = 0, recent = { docs: [], total: 0 }, subjCounts = [];
  try {
    [totalDocs, recent] = await Promise.all([
      state.api.countAllDocuments(),
      state.api.listDocuments({ sort: "recent", limit: 5 })
    ]);
    subjCounts = await Promise.all(state.subjects.map(async s => ({ ...s, count: await state.api.countDocsForSubject(s.id) })));
  } catch (e) {
    if (demoBlocked(e)) return;
    if (!handleApiError(e, "The dashboard could not load.")) throw e;
    return;
  }
  if (token !== state.reqToken) return;

  const chips = subjCounts.map((s, i) => `
    <button class="subj-chip" data-pattern="${(i % 6) + 1}" data-goto-subject="${esc(s.id)}" type="button">
      <span class="subj-chip-name">${esc(s.name)}</span>
      <span class="subj-count">${s.count} document${s.count === 1 ? "" : "s"}</span>
    </button>`).join("");

  dom.main.innerHTML = `
    <div id="dash-root">
    <div class="dash-hero">
      <div class="dash-welcome">
        <p class="kicker" data-reveal>Folio — academic resource library</p>
        <h1 class="page-title dash-greeting" data-reveal>Good ${part}, <span class="accent-dot">${esc(name || "scholar")}</span>.</h1>
        <p class="dash-date" data-reveal>${esc(longDate(new Date()))}</p>
        <form class="dash-search" id="dash-search" role="search" data-reveal>
          <div class="search-field">
            ${icon("search")}
            <input id="dash-q" type="search" placeholder="Search the whole library — titles, descriptions, subjects, tags…" aria-label="Search the entire library" />
          </div>
        </form>
      </div>
      <div class="hero-art reveal-scale" aria-hidden="true">
        <svg viewBox="0 0 560 600" preserveAspectRatio="xMidYMax slice"><use href="#art-cherries"/></svg>
      </div>
    </div>

    <div class="stats-row" data-reveal>
      <div class="stat"><span class="stat-num" data-count="${totalDocs}">0</span><span class="stat-label">Documents available</span></div>
      <div class="stat"><span class="stat-num" data-count="${state.subjects.length}">0</span><span class="stat-label">Subjects</span></div>
      <div class="stat"><span class="stat-num" data-count="${state.stars.size}">0</span><span class="stat-label">Starred by you</span></div>
    </div>

    <div class="dash-cols">
      <section class="dash-panel panel" aria-labelledby="recent-h">
        <div class="section-head"><h2 id="recent-h">Recently added</h2><a class="see-all link-underline" href="#/recent">View all</a></div>
        ${recent.docs.length
          ? `<div class="doc-list">${recent.docs.map(d => rowHtml(d)).join("")}</div>`
          : `<div class="empty"><div class="empty-art">${emptyArt("noDocs")}</div>
              <p class="empty-title">The library is waiting</p>
              <p class="empty-desc">Resources will appear here as soon as they are added${state.isAdmin ? " — head to the Upload Center to add the first one" : ""}.</p>
              ${state.isAdmin ? `<div class="empty-actions"><a class="btn btn-primary" href="#/admin/upload">${icon("upload")}<span>Open Upload Center</span></a></div>` : ""}</div>`}
      </section>
      <section class="dash-panel panel" aria-labelledby="subj-h">
        <div class="section-head"><h2 id="subj-h">Subjects</h2><a class="see-all link-underline" href="#/subjects">All subjects</a></div>
        ${subjCounts.length
          ? `<div class="subject-chips">${chips}</div>`
          : `<div class="empty"><div class="empty-art">${emptyArt("noSubjects")}</div>
              <p class="empty-title">No subjects yet</p>
              <p class="empty-desc">${state.isAdmin ? "Create your first subject to start organising resources." : "Subjects will appear here once the administrator sets them up."}</p>
              ${state.isAdmin ? `<div class="empty-actions"><a class="btn btn-teal" href="#/admin/subjects">${icon("folder-plus")}<span>Manage subjects</span></a></div>` : ""}</div>`}
      </section>
    </div>
    </div>`;

  $$("[data-count]", dom.main).forEach(el => countUp(el, el.dataset.count));
  $("#dash-search").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("#dash-q").value.trim();
    location.hash = "#/library" + (q ? `?q=${encodeURIComponent(q)}` : "");
  });
  $$("[data-goto-subject]", dom.main).forEach(b => b.addEventListener("click", () => {
    location.hash = "#/subject/" + encodeURIComponent(b.dataset.gotoSubject);
  }));
  bindDocListEvents($("#dash-root"), {});
  startReveals(dom.main);
  announce("Dashboard loaded.");
}

/* ----------------------------------------------------------------------------
   18. Views — library (URL-synced search + filters)
---------------------------------------------------------------------------- */
function libraryParamsFromState() {
  const f = state.filters;
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.subject) p.set("subject", f.subject);
  if (f.type) p.set("type", f.type);
  if (f.date) p.set("date", f.date);
  if (f.sort && f.sort !== "recent") p.set("sort", f.sort);
  if (f.view !== "list") p.set("view", f.view);
  if (f.page > 1) p.set("page", String(f.page));
  const s = p.toString();
  return "#/library" + (s ? "?" + s : "");
}
async function viewLibrary(params) {
  document.title = "Folio — Resource Library";
  const f = state.filters;
  f.q = params.get("q") || "";
  f.subject = params.get("subject") || "";
  f.type = params.get("type") || "";
  f.date = params.get("date") || "";
  f.sort = params.get("sort") || "recent";
  f.view = params.get("view") || f.view;
  f.page = Math.max(1, parseInt(params.get("page") || "1", 10) || 1);

  const subjectOpts = state.subjects.map(s => `<option value="${esc(s.id)}" ${f.subject === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("");
  const typeOpts = Object.entries(CATEGORY_LABELS).filter(([k]) => k !== "other")
    .map(([k, v]) => `<option value="${k}" ${f.type === k ? "selected" : ""}>${v}</option>`).join("");
  const dateOpts = [["", "Any time"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"], ["365", "This year"]]
    .map(([v, l]) => `<option value="${v}" ${f.date === v ? "selected" : ""}>${l}</option>`).join("");
  const sortOpts = Object.entries(SORTS).map(([v, s]) => `<option value="${v}" ${f.sort === v ? "selected" : ""}>Sort: ${s.label}</option>`).join("");

  dom.main.innerHTML = `
    <div class="page-head" data-reveal>
      <p class="kicker">Every resource you can access</p>
      <h1 class="page-title">Resource Library</h1>
    </div>
    <div class="toolbar panel" data-reveal>
      <div class="search-field" role="search">
        ${icon("search")}
        <input id="lib-q" type="search" placeholder="Search titles, descriptions, subjects, file types, tags…" aria-label="Search the library" value="${esc(f.q)}" />
        <button class="search-clear" id="lib-q-clear" type="button" aria-label="Clear search" ${f.q ? "" : "hidden"}>${icon("x")}</button>
      </div>
      <select id="lib-subject" aria-label="Filter by subject"><option value="">All subjects</option>${subjectOpts}</select>
      <select id="lib-type" aria-label="Filter by file type"><option value="">All file types</option>${typeOpts}</select>
      <select id="lib-date" aria-label="Filter by date added">${dateOpts}</select>
      <select id="lib-sort" aria-label="Sort results">${sortOpts}</select>
      <div class="view-toggle" role="group" aria-label="Display mode">
        <button class="toggle-btn ${f.view === "list" ? "active" : ""}" id="view-list" type="button" aria-pressed="${f.view === "list"}" aria-label="Editorial list view">${icon("list-rows")}</button>
        <button class="toggle-btn ${f.view === "grid" ? "active" : ""}" id="view-grid" type="button" aria-pressed="${f.view === "grid"}" aria-label="Compact grid view">${icon("panels")}</button>
      </div>
    </div>
    <div class="active-filters" id="lib-chips"></div>
    <p class="results-meta" id="lib-meta"></p>
    <div id="lib-results"></div>
    <nav class="pagination" id="lib-pagination" aria-label="Library pages"></nav>`;

  bindDocListEvents($("#lib-results"), {});
  $("#lib-pagination").addEventListener("click", (e) => {
    const pageBtn = e.target.closest("[data-page]");
    if (pageBtn && !pageBtn.disabled) {
      const f2 = state.filters;
      const cur = f2.page;
      if (pageBtn.dataset.page === "prev") f2.page = Math.max(1, cur - 1);
      else if (pageBtn.dataset.page === "next") f2.page = cur + 1;
      else f2.page = parseInt(pageBtn.dataset.page, 10);
      history.replaceState(null, "", libraryParamsFromState());
      refreshLibraryResults();
    }
  });

  const debouncedSearch = debounce(() => {
    state.filters.q = $("#lib-q").value.trim();
    state.filters.page = 1;
    history.replaceState(null, "", libraryParamsFromState());
    refreshLibraryResults();
  }, 300);
  $("#lib-q").addEventListener("input", () => {
    $("#lib-q-clear").hidden = !$("#lib-q").value;
    debouncedSearch();
  });
  $("#lib-q").addEventListener("search", () => { $("#lib-q-clear").hidden = !$("#lib-q").value; });
  $("#lib-q-clear").addEventListener("click", () => {
    $("#lib-q").value = "";
    $("#lib-q-clear").hidden = true;
    state.filters.q = ""; state.filters.page = 1;
    history.replaceState(null, "", libraryParamsFromState());
    refreshLibraryResults();
    $("#lib-q").focus();
  });
  $("#lib-subject").addEventListener("change", () => { state.filters.subject = $("#lib-subject").value; state.filters.page = 1; syncFilters(); });
  $("#lib-type").addEventListener("change", () => { state.filters.type = $("#lib-type").value; state.filters.page = 1; syncFilters(); });
  $("#lib-date").addEventListener("change", () => { state.filters.date = $("#lib-date").value; state.filters.page = 1; syncFilters(); });
  $("#lib-sort").addEventListener("change", () => { state.filters.sort = $("#lib-sort").value; state.filters.page = 1; syncFilters(); });
  $("#view-list").addEventListener("click", () => setViewMode("list"));
  $("#view-grid").addEventListener("click", () => setViewMode("grid"));

  function syncFilters() {
    history.replaceState(null, "", libraryParamsFromState());
    refreshLibraryResults();
  }
  function setViewMode(v) {
    state.filters.view = v;
    saveFilterPrefs();
    $("#view-list").classList.toggle("active", v === "list");
    $("#view-grid").classList.toggle("active", v === "grid");
    $("#view-list").setAttribute("aria-pressed", String(v === "list"));
    $("#view-grid").setAttribute("aria-pressed", String(v === "grid"));
    history.replaceState(null, "", libraryParamsFromState());
    refreshLibraryResults();
  }

  startReveals(dom.main);
  await refreshLibraryResults();
}

async function refreshLibraryResults() {
  const f = state.filters;
  const token = ++state.reqToken;
  const resultsEl = $("#lib-results"), metaEl = $("#lib-meta"), chipsEl = $("#lib-chips"), pagEl = $("#lib-pagination");
  if (!resultsEl) return;
  metaEl.textContent = "Searching the library…";
  const dateFrom = f.date ? new Date(Date.now() - parseInt(f.date, 10) * 86400000).toISOString() : "";
  let data;
  try {
    data = await state.api.listDocuments({
      search: f.q, subjectId: f.subject, category: f.type, dateFrom,
      sort: f.sort, page: f.page, limit: PAGE_SIZE,
      offset: (f.page - 1) * PAGE_SIZE
    });
  } catch (e) {
    if (demoBlocked(e)) { toast("info", esc(e.userMessage)); return; }
    if (!handleApiError(e, "The library could not be searched.")) {
      resultsEl.innerHTML = `<div class="empty"><div class="empty-art">${emptyArt("offline")}</div><p class="empty-title">The library is unreachable</p><p class="empty-desc">${esc(friendlyError(e))}</p></div>`;
    }
    return;
  }
  if (token !== state.reqToken) return;

  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const subjName = f.subject ? (state.allSubjects.find(s => s.id === f.subject)?.name || "Subject") : "";
  const chips = [];
  if (f.q) chips.push(["q", `Search: “${f.q}”`]);
  if (f.subject) chips.push(["subject", `Subject: ${subjName}`]);
  if (f.type) chips.push(["type", `Type: ${CATEGORY_LABELS[f.type] || f.type}`]);
  if (f.date) chips.push(["date", `Added: ${ {7:"last 7 days",30:"last 30 days",90:"last 90 days",365:"this year"}[f.date] || "" }`]);
  chipsEl.innerHTML = chips.length
    ? `<span class="filters-label">${icon("filter")} Active filters</span>` +
      chips.map(([k, label]) => `<button class="chip" data-clear="${k}" type="button">${esc(label)}<span class="chip-x">${icon("x", "")}</span></button>`).join("") +
      `<button class="clear-all" id="lib-clear-all" type="button">Clear all</button>`
    : "";
  chipsEl.querySelectorAll("[data-clear]").forEach(b => b.addEventListener("click", () => {
    const k = b.dataset.clear;
    state.filters[k] = "";
    if (k === "q") { const qi = $("#lib-q"); if (qi) { qi.value = ""; $("#lib-q-clear").hidden = true; } }
    if (k === "subject") $("#lib-subject").value = "";
    if (k === "type") $("#lib-type").value = "";
    if (k === "date") $("#lib-date").value = "";
    state.filters.page = 1;
    history.replaceState(null, "", libraryParamsFromState());
    refreshLibraryResults();
  }));
  $("#lib-clear-all")?.addEventListener("click", () => {
    state.filters.q = ""; state.filters.subject = ""; state.filters.type = ""; state.filters.date = ""; state.filters.page = 1;
    const qi = $("#lib-q"); if (qi) { qi.value = ""; $("#lib-q-clear").hidden = true; }
    $("#lib-subject").value = ""; $("#lib-type").value = ""; $("#lib-date").value = "";
    history.replaceState(null, "", libraryParamsFromState());
    refreshLibraryResults();
  });

  const start = (f.page - 1) * PAGE_SIZE + 1;
  metaEl.innerHTML = data.total
    ? `Showing <strong>${start}–${Math.min(f.page * PAGE_SIZE, data.total)}</strong> of <strong>${data.total}</strong> accessible document${data.total === 1 ? "" : "s"}`
    : "";

  renderDocResults(resultsEl, { ...data, page: f.page, pages }, {
    view: f.view,
    paginationEl: pagEl,
    emptyKind: f.q || f.subject || f.type || f.date ? "noResults" : "noDocs",
    emptyTitle: f.q || f.subject || f.type || f.date ? "No documents match those filters" : "The library is empty",
    emptyDesc: f.q || f.subject || f.type || f.date
      ? "Nothing in the accessible library matches this combination. Try loosening a filter or clearing them all."
      : (state.isAdmin
        ? "Resources will appear here once uploaded. Open the Upload Center to add the first documents."
        : "Resources will appear here when your administrator adds them."),
    emptyActions: state.isAdmin ? `<a class="btn btn-primary" href="#/admin/upload">${icon("upload")}<span>Open Upload Center</span></a>` : ""
  });
}

/* ----------------------------------------------------------------------------
   19. Views — subjects index + subject page
---------------------------------------------------------------------------- */
async function viewSubjectsIndex() {
  document.title = "Folio — Subjects";
  dom.main.innerHTML = `
    <div class="page-head" data-reveal>
      <p class="kicker">Collections of resources</p>
      <h1 class="page-title">Subjects</h1>
      <p class="page-sub">Every subject curated by your administrator, with live document counts.</p>
    </div>
    <div class="loading-block"><span class="spinner"></span>Loading subjects…</div>`;
  let counts;
  try {
    counts = await Promise.all(state.subjects.map(async s => ({ ...s, count: await state.api.countDocsForSubject(s.id) })));
  } catch (e) {
    if (!handleApiError(e, "Subjects could not be loaded.")) throw e;
    return;
  }
  const cards = counts.map((s, i) => `
    <button class="subject-card" data-goto-subject="${esc(s.id)}" data-reveal type="button">
      <span class="subject-card-band" data-pattern="${(i % 6) + 1}"></span>
      <span class="subject-card-body">
        <h3>${esc(s.name)} ${icon("chevron")}</h3>
        <p>${esc(s.description || "No description yet.")}</p>
        <span class="subject-card-count">${s.count} document${s.count === 1 ? "" : "s"}</span>
      </span>
    </button>`).join("");
  dom.main.innerHTML = `
    <div class="page-head" data-reveal>
      <p class="kicker">Collections of resources</p>
      <h1 class="page-title">Subjects</h1>
      <p class="page-sub">Every subject curated by your administrator, with live document counts.</p>
    </div>
    ${counts.length
      ? `<div class="subjects-grid">${cards}</div>`
      : `<div class="empty"><div class="empty-art">${emptyArt("noSubjects")}</div>
          <p class="empty-title">No subjects configured</p>
          <p class="empty-desc">${state.isAdmin ? "Create subjects first — documents are organised under them." : "The administrator has not created any subjects yet."}</p>
          ${state.isAdmin ? `<div class="empty-actions"><a class="btn btn-teal" href="#/admin/subjects">${icon("folder-plus")}<span>Manage subjects</span></a></div>` : ""}</div>`}`;
  $$("[data-goto-subject]", dom.main).forEach(b => b.addEventListener("click", () => {
    location.hash = "#/subject/" + encodeURIComponent(b.dataset.gotoSubject);
  }));
  startReveals(dom.main);
}

async function viewSubjectPage(subjectId) {
  const subject = state.allSubjects.find(s => s.id === subjectId);
  if (!subject) {
    dom.main.innerHTML = `<div class="empty"><div class="empty-art">${emptyArt("noResults")}</div><p class="empty-title">Subject not found</p><p class="empty-desc">It may have been renamed or archived.</p><div class="empty-actions"><a class="btn" href="#/subjects">Back to subjects</a></div></div>`;
    return;
  }
  document.title = `Folio — ${subject.name}`;
  const pattern = (state.allSubjects.findIndex(s => s.id === subjectId) % 6) + 1;
  dom.main.innerHTML = `
    <section class="subject-hero" data-reveal>
      <div class="subject-hero-band" data-pattern="${pattern}"></div>
      <div class="subject-hero-info">
        <div>
          <p class="kicker">Subject collection</p>
          <h1>${esc(subject.name)}</h1>
          <p class="page-sub">${esc(subject.description || "No description for this subject yet.")}</p>
          <div class="subject-hero-meta" style="margin-top:12px">
            <span class="chip chip-teal" id="subj-count">— documents</span>
            ${subject.archived ? `<span class="chip archived-badge">Archived</span>` : ""}
          </div>
        </div>
        <a class="btn" href="#/subjects">${icon("chevron")}<span>All subjects</span></a>
      </div>
    </section>
    <div class="toolbar panel" data-reveal>
      <div class="search-field" role="search">
        ${icon("search")}
        <input id="subj-q" type="search" placeholder="Search within ${esc(subject.name)}…" aria-label="Search within ${esc(subject.name)}" />
        <button class="search-clear" id="subj-q-clear" type="button" aria-label="Clear search" hidden>${icon("x")}</button>
      </div>
      <select id="subj-type" aria-label="Filter by file type"><option value="">All file types</option>${Object.entries(CATEGORY_LABELS).filter(([k]) => k !== "other").map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
      <select id="subj-sort" aria-label="Sort">${Object.entries(SORTS).map(([v, s]) => `<option value="${v}" ${v === "recent" ? "selected" : ""}>Sort: ${s.label}</option>`).join("")}</select>
    </div>
    <p class="results-meta" id="subj-meta"></p>
    <div id="subj-results"></div>
    <nav class="pagination" id="subj-pagination" aria-label="Subject pages"></nav>`;
  startReveals(dom.main);

  const local = { q: "", type: "", sort: "recent", page: 1 };
  async function refresh() {
    const token = ++state.reqToken;
    $("#subj-meta").textContent = "Searching…";
    let data;
    try {
      data = await state.api.listDocuments({
        search: local.q, subjectId, category: local.type, sort: local.sort,
        limit: PAGE_SIZE, offset: (local.page - 1) * PAGE_SIZE
      });
    } catch (e) {
      if (!handleApiError(e, "This subject could not be loaded.")) throw e;
      return;
    }
    if (token !== state.reqToken) return;
    $("#subj-count").textContent = `${data.total} document${data.total === 1 ? "" : "s"}`;
    $("#subj-meta").innerHTML = data.total ? `Showing <strong>${Math.min(data.total, (local.page - 1) * PAGE_SIZE + 1)}–${Math.min(local.page * PAGE_SIZE, data.total)}</strong> of <strong>${data.total}</strong>` : "";
    const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
    renderDocResults($("#subj-results"), { ...data, page: local.page, pages }, {
      view: "list",
      paginationEl: $("#subj-pagination"),
      emptyKind: local.q || local.type ? "noResults" : "noDocs",
      emptyTitle: local.q || local.type ? "Nothing matches in this subject" : "This subject is empty for now",
      emptyDesc: local.q || local.type ? "Try a different search term or clear the file-type filter." : (state.isAdmin ? "Upload resources and assign them to this subject." : "Resources will appear here when they are added to this subject.")
    });
  }
  bindDocListEvents($("#subj-results"), {});
  $("#subj-pagination").addEventListener("click", (e) => {
    const pageBtn = e.target.closest("[data-page]");
    if (pageBtn && !pageBtn.disabled) {
      local.page = pageBtn.dataset.page === "prev" ? Math.max(1, local.page - 1)
        : pageBtn.dataset.page === "next" ? local.page + 1
        : parseInt(pageBtn.dataset.page, 10);
      refresh();
    }
  });
  $("#subj-q").addEventListener("input", debounce(() => {
    local.q = $("#subj-q").value.trim(); local.page = 1;
    $("#subj-q-clear").hidden = !$("#subj-q").value;
    refresh();
  }, 300));
  $("#subj-q-clear").addEventListener("click", () => { local.q = ""; $("#subj-q").value = ""; $("#subj-q-clear").hidden = true; refresh(); });
  $("#subj-type").addEventListener("change", () => { local.type = $("#subj-type").value; local.page = 1; refresh(); });
  $("#subj-sort").addEventListener("change", () => { local.sort = $("#subj-sort").value; local.page = 1; refresh(); });
  await refresh();
}

/* ----------------------------------------------------------------------------
   20. Views — recent + starred
---------------------------------------------------------------------------- */
async function viewRecent() {
  document.title = "Folio — Recently Added";
  dom.main.innerHTML = `<div class="page-head" data-reveal><p class="kicker">Fresh from the upload desk</p><h1 class="page-title">Recently Added</h1></div><div class="loading-block"><span class="spinner"></span>Fetching the latest resources…</div>`;
  let data;
  try {
    data = await state.api.listDocuments({ sort: "recent", limit: 30, offset: 0 });
  } catch (e) {
    if (!handleApiError(e, "Recent documents could not be loaded.")) throw e;
    return;
  }
  dom.main.innerHTML = `
    <div class="page-head" data-reveal>
      <p class="kicker">Fresh from the upload desk</p>
      <h1 class="page-title">Recently Added</h1>
      <p class="page-sub">The ${Math.min(30, data.total)} most recent resources across every subject.</p>
    </div>
    <div id="recent-results"></div>`;
  startReveals(dom.main);
  renderDocResults($("#recent-results"), { ...data, page: 1, pages: 1 }, {
    view: state.filters.view,
    emptyKind: "noDocs",
    emptyTitle: "Nothing added yet",
    emptyDesc: "New uploads will appear here first.",
    emptyActions: state.isAdmin ? `<a class="btn btn-primary" href="#/admin/upload">${icon("upload")}<span>Open Upload Center</span></a>` : ""
  });
  bindDocListEvents($("#recent-results"), {});
}

async function viewStarred() {
  document.title = "Folio — Starred";
  dom.main.innerHTML = `<div class="page-head" data-reveal><p class="kicker">Your personal shortlist</p><h1 class="page-title">Starred</h1></div><div class="loading-block"><span class="spinner"></span>Collecting your stars…</div>`;
  let docs = [];
  try {
    const ids = Array.from(state.stars.keys());
    if (ids.length) {
      const fetched = await state.api.listDocumentsByIds(ids);
      const byId = new Map(fetched.map(d => [d.id, d]));
      /* A starred document that is no longer accessible (deleted / restricted)
         is silently dropped from the view but stays harmless. */
      docs = ids.map(id => byId.get(id)).filter(Boolean);
    }
  } catch (e) {
    if (!handleApiError(e, "Your starred list could not be loaded.")) throw e;
    return;
  }
  dom.main.innerHTML = `
    <div class="page-head" data-reveal>
      <p class="kicker">Your personal shortlist</p>
      <h1 class="page-title">Starred</h1>
      <p class="page-sub">Private to you — other members see their own stars.</p>
    </div>
    <div id="starred-results"></div>`;
  startReveals(dom.main);
  renderDocResults($("#starred-results"), { docs, total: docs.length, page: 1, pages: 1 }, {
    view: state.filters.view,
    emptyKind: "noStars",
    emptyTitle: "No starred documents yet",
    emptyDesc: "Use the star button on any document to keep it close at hand.",
    emptyActions: `<a class="btn btn-teal" href="#/library">${icon("books")}<span>Browse the library</span></a>`
  });
  bindDocListEvents($("#starred-results"), {});
}
function chunkArr(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/* ----------------------------------------------------------------------------
   21. Views — settings
---------------------------------------------------------------------------- */
function viewSettings() {
  document.title = "Folio — Settings";
  const p = state.profile || {}, u = state.user || {};
  const role = state.isAdmin ? "Administrator" : (p.role === "admin" ? "Administrator" : "Viewer");
  dom.main.innerHTML = `
    <div class="page-head" data-reveal>
      <p class="kicker">Your account</p>
      <h1 class="page-title">Settings</h1>
    </div>
    <div class="settings-grid">
      <section class="settings-panel panel" data-reveal aria-labelledby="acc-h">
        <h2 id="acc-h">Account details</h2>
        <p class="panel-sub">Identity and role are managed by your administrator.</p>
        <div class="detail-rows">
          <div class="detail-row"><span class="detail-key">Display name</span><span class="detail-val">${esc(p.displayName || u.name || "—")}</span></div>
          <div class="detail-row"><span class="detail-key">Email</span><span class="detail-val">${esc(u.email || p.email || "—")}</span></div>
          <div class="detail-row"><span class="detail-key">Username</span><span class="detail-val">${esc(p.username || "—")}</span></div>
          <div class="detail-row"><span class="detail-key">Role</span><span class="detail-val">${esc(role)}</span></div>
          <div class="detail-row"><span class="detail-key">Account ID</span><span class="detail-val">${esc(u.id || "—")}</span></div>
        </div>
        <div style="margin-top:16px">
          <button class="btn btn-danger" id="settings-logout" type="button">${icon("logout")}<span>Log out</span></button>
        </div>
      </section>
      <section class="settings-panel panel" data-reveal aria-labelledby="pw-h">
        <h2 id="pw-h">Change password</h2>
        <p class="panel-sub">Choose a strong password of at least 8 characters.</p>
        <form id="pw-form" novalidate>
          <div class="field">
            <label for="cur-pw">Current password</label>
            <input id="cur-pw" type="password" autocomplete="current-password" />
            <p class="field-error" id="cur-pw-err" hidden></p>
          </div>
          <div class="field">
            <label for="new-pw">New password</label>
            <input id="new-pw" type="password" autocomplete="new-password" />
            <p class="field-error" id="new-pw-err" hidden></p>
          </div>
          <div class="field">
            <label for="conf-pw">Confirm new password</label>
            <input id="conf-pw" type="password" autocomplete="new-password" />
            <p class="field-error" id="conf-pw-err" hidden></p>
          </div>
          <button class="btn btn-primary" id="pw-save" type="submit"><span class="btn-label">Update password</span></button>
        </form>
        <div id="pw-result" style="margin-top:12px"></div>
      </section>
    </div>`;
  $("#settings-logout").addEventListener("click", doLogout);
  $("#pw-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const cur = $("#cur-pw").value, next = $("#new-pw").value, conf = $("#conf-pw").value;
    let ok = true;
    ok = setFieldError($("#cur-pw"), "cur-pw-err", cur ? "" : "Enter your current password.") && ok;
    ok = setFieldError($("#new-pw"), "new-pw-err", next.length >= 8 ? "" : "Use at least 8 characters.") && ok;
    ok = setFieldError($("#conf-pw"), "conf-pw-err", conf === next ? "" : "Passwords do not match.") && ok;
    if (!ok) return;
    const btn = $("#pw-save");
    btn.classList.add("is-loading");
    try {
      await state.api.changePassword(cur, next);
      $("#pw-result").innerHTML = `<div class="alert alert-success">${icon("check")}<span>Your password has been updated.</span></div>`;
      $("#pw-form").reset();
      toast("success", "Password updated.");
      announce("Password updated.");
    } catch (err2) {
      if (demoBlocked(err2)) { $("#pw-result").innerHTML = `<div class="alert alert-info">${icon("info")}<span>${esc(err2.userMessage)}</span></div>`; }
      else {
        const msg = esc(friendlyError(err2, "The password could not be changed."));
        $("#pw-result").innerHTML = `<div class="alert alert-error">${icon("alert")}<span>${msg}</span></div>`;
        if (/current password|credentials/i.test(msg)) setFieldError($("#cur-pw"), "cur-pw-err", "That current password was not accepted.");
      }
    } finally { btn.classList.remove("is-loading"); }
  });
  startReveals(dom.main);
}

/* ----------------------------------------------------------------------------
   22. Views — administrator
---------------------------------------------------------------------------- */
async function viewAdmin(tab) {
  document.title = "Folio — Administrator";
  const tabs = [["upload", "Upload Center", "upload"], ["documents", "Manage Documents", "doc"], ["subjects", "Manage Subjects", "folder-plus"]];
  dom.main.innerHTML = `
    <div class="page-head" data-reveal>
      <p class="kicker">Administrator tools</p>
      <h1 class="page-title">Administration</h1>
    </div>
    <div class="tabs" role="tablist" aria-label="Administrator sections">
      ${tabs.map(([k, label]) => `<button class="tab ${tab === k ? "active" : ""}" role="tab" aria-selected="${tab === k}" data-admin-tab="${k}" type="button">${label}</button>`).join("")}
    </div>
    <div id="admin-body"><div class="loading-block"><span class="spinner"></span>Loading…</div></div>`;
  startReveals(dom.main);
  $$("[data-admin-tab]", dom.main).forEach(b => b.addEventListener("click", () => {
    location.hash = "#/admin/" + b.dataset.adminTab;
  }));
  if (tab === "documents") await adminDocumentsTab();
  else if (tab === "subjects") await adminSubjectsTab();
  else await adminUploadTab();
}

/* --- Upload Center --------------------------------------------------------- */
async function adminUploadTab() {
  const body = $("#admin-body");
  if (!state.subjects.length) {
    body.innerHTML = `
      <div class="empty">
        <div class="empty-art">${emptyArt("noSubjects")}</div>
        <p class="empty-title">Create a subject first</p>
        <p class="empty-desc">Every uploaded document must belong to a subject. Set up your subjects, then come back to upload.</p>
        <div class="empty-actions"><a class="btn btn-teal" href="#/admin/subjects">${icon("folder-plus")}<span>Manage subjects</span></a></div>
      </div>`;
    return;
  }
  const maxMB = FOLIO_ADVANCED.maxFileSizeMB;
  const subjectOpts = state.subjects.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
  body.innerHTML = `
    <div class="panel" data-reveal style="padding:18px">
      <div class="upload-zone" id="upload-zone" role="button" tabindex="0"
           aria-label="Upload resources: drag files here, or press Enter to browse"
           aria-describedby="upload-help">
        <span class="uz-glyph">${icon("upload")}</span>
        <span class="uz-title">Drag resources here, or browse</span>
        <span class="uz-hint" id="upload-help">Multiple files supported — PDF, Word, PowerPoint, Excel, images, video and archives, up to <strong>${maxMB} MB</strong> each.</span>
        <span class="uz-allowlist">pdf · docx · doc · pptx · ppt · xlsx · xls · txt · csv · png · jpg · jpeg · webp · mp4 · zip</span>
        <button class="btn btn-teal" id="btn-browse" type="button">${icon("plus")}<span>Choose files</span></button>
      </div>
      <div class="upload-meta">
        <div class="field">
          <label for="up-subject">Subject for queued files</label>
          <select id="up-subject">${subjectOpts}</select>
          <p class="field-hint">Applied when the queue is uploaded. Queued items follow this selection.</p>
        </div>
        <div class="field">
          <label for="up-tags">Tags (optional, comma separated)</label>
          <input id="up-tags" type="text" placeholder="revision, term-2, worksheet" />
          <p class="field-hint">Tags power search and filtering across the library.</p>
        </div>
      </div>
      <div class="upload-actions">
        <button class="btn btn-primary" id="btn-upload-all" type="button" disabled>${icon("upload")}<span>Upload queue</span></button>
        <button class="btn" id="btn-clear-done" type="button" hidden>Clear completed</button>
        <span class="upload-count" id="upload-count" aria-live="polite"></span>
      </div>
    </div>
    <div class="upload-queue" id="upload-queue"></div>`;

  const zone = $("#upload-zone");
  zone.addEventListener("click", (e) => { if (!e.target.closest("#btn-browse")) openUploadPicker(); });
  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openUploadPicker(); }
  });
  $("#btn-browse").addEventListener("click", openUploadPicker);
  ["dragenter", "dragover"].forEach(ev => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("dragging"); }));
  ["dragleave", "drop"].forEach(ev => zone.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === "dragleave" && zone.contains(e.relatedTarget)) return;
    zone.classList.remove("dragging");
    if (ev === "drop") handleDroppedFiles(e.dataTransfer);
  }));
  $("#btn-upload-all").addEventListener("click", pumpQueue);
  $("#btn-clear-done").addEventListener("click", () => {
    state.queue = state.queue.filter(i => !["completed", "invalid", "cancelled"].includes(i.status));
    renderQueue();
  });
  renderQueue();
  startReveals(dom.main);
}
function openUploadPicker() {
  state.filePickerMode = "upload";
  dom.fileInput.value = "";
  dom.fileInput.click();
}
function handleDroppedFiles(dt) {
  const files = Array.from(dt.files || []);
  if (!files.length) return;
  if (state.demo) { toast("info", "Preview mode — file uploads need a connected backend. Configure FOLIO_CONFIG to enable them."); return; }
  enqueueFiles(files);
}
function enqueueFiles(files) {
  let added = 0, rejected = 0;
  const maxBytes = FOLIO_ADVANCED.maxFileSizeMB * 1048576;
  for (const file of files) {
    const ext = extOf(file.name);
    if (!EXT_META[ext]) {
      state.queue.push({ id: uid(), file, title: file.name, description: "", status: "invalid", error: `“.${ext || "?"}” files are not on the allowed list.`, progress: 0 });
      rejected++;
      continue;
    }
    if (file.size > maxBytes) {
      state.queue.push({ id: uid(), file, title: file.name, description: "", status: "invalid", error: `File is ${fmtBytes(file.size)} — the limit is ${FOLIO_ADVANCED.maxFileSizeMB} MB.`, progress: 0 });
      rejected++;
      continue;
    }
    if (state.queue.some(i => i.file.name === file.name && i.file.size === file.size && !["completed", "failed"].includes(i.status))) {
      toast("info", `<strong>${esc(file.name)}</strong> is already in the queue.`);
      continue;
    }
    state.queue.push({
      id: uid(), file,
      title: file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || file.name,
      description: "", status: "queued", error: "", progress: 0, indeterminate: false, attempts: 0
    });
    added++;
  }
  if (added) toast("info", `${added} file${added === 1 ? "" : "s"} queued and ready.`);
  if (rejected) announce(`${rejected} file${rejected === 1 ? "" : "s"} were rejected by validation.`);
  renderQueue();
}
function renderQueue() {
  const wrap = $("#upload-queue");
  if (!wrap) return;
  wrap.innerHTML = state.queue.map(item => queueItemHtml(item)).join("");
  state.queue.forEach(item => bindQueueItem(item));
  const queued = state.queue.filter(i => i.status === "queued").length;
  const btn = $("#btn-upload-all");
  if (btn) {
    btn.disabled = queued === 0 || state.uploading;
    btn.innerHTML = state.uploading
      ? `${icon("upload")}<span>Uploading…</span>`
      : `${icon("upload")}<span>Upload ${queued ? queued + (queued === 1 ? " file" : " files") : "queue"}</span>`;
  }
  const done = $("#btn-clear-done");
  if (done) done.hidden = !state.queue.some(i => ["completed", "invalid", "failed", "cancelled"].includes(i.status));
  const count = $("#upload-count");
  if (count) {
    const by = {};
    state.queue.forEach(i => { by[i.status] = (by[i.status] || 0) + 1; });
    count.textContent = state.queue.length
      ? Object.entries(by).map(([k, v]) => `${v} ${k}`).join(" · ") : "";
  }
}
function queueItemHtml(item) {
  const cat = fileCat(item.file.name, item.file.type);
  return `
  <article class="q-item" data-status="${item.status}" data-qid="${item.id}">
    <div class="q-head">
      <span class="tile" data-cat="${esc(cat)}" aria-hidden="true">${esc(tileCode(cat))}</span>
      <div style="min-width:0">
        <p class="q-name">${esc(item.file.name)}</p>
        <p class="q-sub">${esc(fileLabel(item.file.name))} · ${esc(fmtBytes(item.file.size))}${item.fileId ? " · file stored: " + esc(item.fileId) : ""}</p>
      </div>
      <span class="q-status">${esc(item.status)}</span>
    </div>
    <div class="q-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${item.progress}" aria-label="Upload progress for ${esc(item.file.name)}">
      <div class="q-fill ${item.indeterminate ? "indeterminate" : ""}" style="width:${item.progress}%"></div>
    </div>
    ${item.error ? `<p class="q-error">${esc(item.error)}</p>` : ""}
    ${["queued", "failed"].includes(item.status) ? `
      <div class="q-fields">
        <div class="field"><label for="q-title-${item.id}">Title</label>
          <input id="q-title-${item.id}" type="text" value="${esc(item.title)}" data-q-field="title" /></div>
        <div class="field"><label for="q-desc-${item.id}">Description (optional)</label>
          <input id="q-desc-${item.id}" type="text" value="${esc(item.description)}" data-q-field="description" placeholder="Short summary shown in the library" /></div>
      </div>` : ""}
    <div class="q-actions">
      ${item.status === "failed" && item.stage === "metadata" ? `<button class="btn btn-sm btn-teal" data-q-action="retry-meta" type="button">${icon("refresh")}<span>Retry metadata step</span></button>` : ""}
      ${item.status === "failed" && item.stage === "upload" ? `<button class="btn btn-sm btn-teal" data-q-action="retry" type="button">${icon("refresh")}<span>Retry upload</span></button>` : ""}
      ${["queued", "invalid", "failed", "completed"].includes(item.status) ? `<button class="btn btn-sm btn-danger" data-q-action="remove" type="button">${icon("trash")}<span>Remove</span></button>` : ""}
    </div>
  </article>`;
}
function bindQueueItem(item) {
  const el = $(`[data-qid="${item.id}"]`, $("#upload-queue"));
  if (!el) return;
  el.querySelectorAll("[data-q-field]").forEach(inp => inp.addEventListener("input", () => {
    item[inp.dataset.qField] = inp.value;
  }));
  el.querySelectorAll("[data-q-action]").forEach(b => b.addEventListener("click", () => {
    const a = b.dataset.qAction;
    if (a === "remove") {
      if (item.status === "uploading" || item.status === "processing") return;
      state.queue = state.queue.filter(i => i.id !== item.id);
      renderQueue();
    } else if (a === "retry") {
      item.status = "queued"; item.error = ""; item.progress = 0; item.indeterminate = false; item.fileId = null; item.stage = null;
      renderQueue(); pumpQueue();
    } else if (a === "retry-meta") {
      item.status = "processing"; item.error = "";
      renderQueue(); finalizeMetadata(item);
    }
  }));
}
function parseTags() {
  const raw = $("#up-tags")?.value || "";
  return raw.split(",").map(t => t.trim()).filter(Boolean).slice(0, 10).map(t => t.slice(0, 64));
}
async function pumpQueue() {
  if (state.uploading) return;
  if (!state.queue.some(i => i.status === "queued")) return;
  const subjectId = $("#up-subject")?.value;
  if (!subjectId) { toast("error", "Choose a subject for the queue first."); return; }
  state.uploading = true;
  renderQueue();
  announce("Uploads starting.");
  try {
    while (true) {
      const item = state.queue.find(i => i.status === "queued");
      if (!item) break;
      try {
        await uploadOne(item, subjectId);
      } catch (e) {
        if (e && (e.code === 401 || e.type === "session_expired")) { sessionExpired(); break; }
      }
    }
  } finally {
    state.uploading = false;
    renderQueue();
    announce("Upload queue finished.");
  }
}
async function uploadOne(item, subjectId) {
  item.status = "uploading"; item.progress = 0; item.indeterminate = false; item.error = ""; item.stage = "upload";
  renderQueue();
  announce(`Uploading ${item.file.name}.`);
  const indeterminateTimer = setTimeout(() => {
    if (item.status === "uploading" && item.progress === 0) {
      item.indeterminate = true;
      const fill = $(`[data-qid="${item.id}"] .q-fill`);
      if (fill) fill.classList.add("indeterminate");
    }
  }, 1400);
  try {
    const tags = parseTags();
    const { fileId, promise } = state.api.uploadFile(item.file, (pct) => {
      clearTimeout(indeterminateTimer);
      item.indeterminate = false;
      item.progress = pct;
      const row = $(`[data-qid="${item.id}"]`);
      if (row) {
        row.querySelector(".q-fill").style.width = pct + "%";
        row.querySelector(".q-fill").classList.remove("indeterminate");
        row.querySelector(".q-bar").setAttribute("aria-valuenow", String(pct));
      }
      if (pct % 25 === 0) announce(`${item.file.name} — ${pct}% uploaded.`);
    });
    item.fileId = fileId;
    await promise;
    clearTimeout(indeterminateTimer);
    item.status = "processing";
    renderQueue();
    item.doc = await state.api.createDocument(buildUploadPayload(item, subjectId, tags));
    item.status = "completed";
    item.error = "";
    renderQueue();
    toast("success", `<strong>${esc(item.file.name)}</strong> added to the library.`);
    refreshAfterUpload();
  } catch (e) {
    clearTimeout(indeterminateTimer);
    item.status = "failed";
    item.error = friendlyError(e, "The upload failed.");
    if (demoBlocked(e)) item.error = "Preview mode — uploads need a connected backend.";
    renderQueue();
    toast("error", `<strong>${esc(item.file.name)}</strong> failed: ${esc(item.error)}`);
    const code = e && e.code;
    if (code === 401 || (e && e.type === "session_expired")) throw e; /* abort the queue */
  }
}
function buildUploadPayload(item, subjectId, tags) {
  const subject = state.allSubjects.find(s => s.id === subjectId) || { name: "" };
  const cat = fileCat(item.file.name, item.file.type);
  const mime = EXT_META[extOf(item.file.name)]?.mime || item.file.type || "application/octet-stream";
  return {
    title: item.title.trim() || item.file.name,
    description: (item.description || "").trim(),
    subjectId, subjectName: subject.name,
    fileId: item.fileId, fileName: item.file.name,
    mimeType: mime, category: cat,
    fileSize: item.file.size,
    tags, uploadedBy: state.user.id, uploadedByName: state.profile?.displayName || state.user.name || "",
    searchText: buildSearchText([item.title, item.description, subject.name, EXT_META[extOf(item.file.name)]?.label || "", tags.join(" "), item.file.name])
  };
}
async function finalizeMetadata(item) {
  const subjectId = $("#up-subject")?.value || state.allSubjects[0]?.id;
  try {
    item.status = "processing";
    renderQueue();
    item.doc = await state.api.createDocument(buildUploadPayload(item, subjectId, parseTags()));
    item.status = "completed"; item.error = "";
    renderQueue();
    toast("success", `<strong>${esc(item.file.name)}</strong> added to the library.`);
    refreshAfterUpload();
  } catch (e) {
    item.status = "failed"; item.stage = "metadata";
    item.error = "The file was stored, but its library record could not be created. " + friendlyError(e, "Retry the metadata step — the stored file is safe.");
    renderQueue();
  }
}
async function refreshAfterUpload() {
  try {
    state.allSubjects = await state.api.listSubjects({ includeArchived: true });
    state.subjects = state.allSubjects.filter(s => !s.archived);
  } catch { /* counts refresh on next navigation */ }
  const key = navKeyFor(parseHash().segs);
  if (key === "dashboard") route();
  else if (key === "library") refreshLibraryResults();
  else if (key === "admin-documents") route();
}

/* --- Manage documents ------------------------------------------------------ */
async function adminDocumentsTab() {
  const f = state.adminDocs;
  f.page = f.page || 1;
  const subjectOpts = state.subjects.map(s => `<option value="${esc(s.id)}" ${f.subject === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("");
  $("#admin-body").innerHTML = `
    <div class="admin-toolbar">
      <div class="search-field" role="search">
        ${icon("search")}
        <input id="ad-q" type="search" placeholder="Search documents…" aria-label="Search documents" value="${esc(f.q)}" />
        <button class="search-clear" id="ad-q-clear" type="button" aria-label="Clear search" hidden>${icon("x")}</button>
      </div>
      <select id="ad-subject" aria-label="Filter by subject"><option value="">All subjects</option>${subjectOpts}</select>
      <select id="ad-sort" aria-label="Sort">${Object.entries(SORTS).map(([v, s]) => `<option value="${v}" ${f.sort === v ? "selected" : ""}>Sort: ${s.label}</option>`).join("")}</select>
    </div>
    <p class="results-meta" id="ad-meta"></p>
    <div id="ad-results"></div>
    <nav class="pagination" id="ad-pagination" aria-label="Document pages"></nav>`;
  startReveals(dom.main);

  async function refresh() {
    const token = ++state.reqToken;
    $("#ad-meta").textContent = "Loading…";
    let data;
    try {
      data = await state.api.listDocuments({ search: f.q, subjectId: f.subject, sort: f.sort, limit: PAGE_SIZE, offset: (f.page - 1) * PAGE_SIZE });
    } catch (e) {
      if (!handleApiError(e, "Documents could not be loaded.")) throw e;
      return;
    }
    if (token !== state.reqToken) return;
    const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
    $("#ad-meta").innerHTML = data.total ? `<strong>${data.total}</strong> document${data.total === 1 ? "" : "s"} in the library` : "";
    renderDocResults($("#ad-results"), { ...data, page: f.page, pages }, {
      view: "list",
      paginationEl: $("#ad-pagination"),
      emptyKind: f.q || f.subject ? "noResults" : "noDocs",
      emptyTitle: f.q || f.subject ? "No documents match" : "No documents yet",
      emptyDesc: f.q || f.subject ? "Adjust the search or subject filter." : "Upload resources to populate the library."
    });
  }
  bindDocListEvents($("#ad-results"), {});
  $("#ad-pagination").addEventListener("click", (e) => {
    const pageBtn = e.target.closest("[data-page]");
    if (pageBtn && !pageBtn.disabled) {
      f.page = pageBtn.dataset.page === "prev" ? Math.max(1, f.page - 1)
        : pageBtn.dataset.page === "next" ? f.page + 1
        : parseInt(pageBtn.dataset.page, 10);
      refresh();
    }
  });
  $("#ad-q").addEventListener("input", debounce(() => { f.q = $("#ad-q").value.trim(); f.page = 1; $("#ad-q-clear").hidden = !f.q; refresh(); }, 300));
  $("#ad-q-clear").addEventListener("click", () => { f.q = ""; $("#ad-q").value = ""; $("#ad-q-clear").hidden = true; refresh(); });
  $("#ad-subject").addEventListener("change", () => { f.subject = $("#ad-subject").value; f.page = 1; refresh(); });
  $("#ad-sort").addEventListener("change", () => { f.sort = $("#ad-sort").value; f.page = 1; refresh(); });
  await refresh();
}

/* --- Manage subjects -------------------------------------------------------- */
async function adminSubjectsTab() {
  $("#admin-body").innerHTML = `
    <form class="subject-create panel" id="subj-create" data-reveal>
      <p class="kicker" style="margin-bottom:12px">New subject</p>
      <div class="form-grid">
        <div class="field"><label for="ns-name">Name</label><input id="ns-name" type="text" required maxlength="128" placeholder="e.g. Computer Science" /></div>
        <div class="field"><label for="ns-desc">Description (optional)</label><input id="ns-desc" type="text" maxlength="1024" placeholder="What belongs in this collection?" /></div>
        <button class="btn btn-primary" type="submit">${icon("plus")}<span>Create subject</span></button>
      </div>
    </form>
    <div class="loading-block"><span class="spinner"></span>Loading subjects…</div>`;
  await renderSubjectManageList();
  $("#subj-create").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#ns-name").value.trim();
    if (!name) { toast("error", "Give the subject a name."); return; }
    try {
      await state.api.createSubject({ name, description: $("#ns-desc").value.trim() });
      toast("success", `Subject <strong>${esc(name)}</strong> created.`);
      state.allSubjects = await state.api.listSubjects({ includeArchived: true });
      state.subjects = state.allSubjects.filter(s => !s.archived);
      $("#ns-name").value = ""; $("#ns-desc").value = "";
      renderSubjectManageList();
      announce("Subject created.");
    } catch (err) { handleApiError(err, "The subject could not be created."); }
  });
}
async function renderSubjectManageList() {
  try {
    state.allSubjects = await state.api.listSubjects({ includeArchived: true });
    state.subjects = state.allSubjects.filter(s => !s.archived);
  } catch (e) { if (!handleApiError(e, "Subjects could not be loaded.")) throw e; return; }
  const rows = await Promise.all(state.allSubjects.map(async s => `
    <div class="subject-manage-row" data-reveal data-sid="${esc(s.id)}">
      <span class="sm-name">${esc(s.name)}</span>
      ${s.archived ? `<span class="chip archived-badge">Archived</span>` : `<span class="chip chip-teal">Active</span>`}
      <div class="sm-actions">
        <button class="btn btn-sm" data-sm-action="rename" type="button">${icon("edit")}<span>Rename</span></button>
        <button class="btn btn-sm" data-sm-action="archive" type="button">${icon("swap")}<span>${s.archived ? "Unarchive" : "Archive"}</span></button>
      </div>
      <span class="sm-desc">${esc(s.description || "No description.")} · created ${esc(fmtDate(s.createdAt))}</span>
    </div>`));
  const wrap = $(".subject-create", dom.main).nextElementSibling;
  wrap.outerHTML = rows.length
    ? `<div class="subject-manage-list">${rows.join("")}</div>`
    : `<div class="empty"><div class="empty-art">${emptyArt("noSubjects")}</div><p class="empty-title">No subjects yet</p><p class="empty-desc">Create the first subject above.</p></div>`;
  startReveals(dom.main);
  $$("[data-sm-action]", dom.main).forEach(b => b.addEventListener("click", async () => {
    const sid = b.closest("[data-sid]").dataset.sid;
    const subject = state.allSubjects.find(s => s.id === sid);
    if (b.dataset.smAction === "rename") renameSubjectFlow(subject);
    else {
      const archiving = !subject.archived;
      const ok = await confirmDialog({
        title: (archiving ? "Archive" : "Unarchive") + " “" + subject.name + "”?",
        body: archiving
          ? "Archived subjects disappear from navigation and filters, but their documents stay in the library and remain accessible."
          : "This subject will reappear in navigation and filters.",
        confirmLabel: archiving ? "Archive subject" : "Unarchive subject"
      });
      if (!ok) return;
      try {
        await state.api.updateSubject(sid, { archived: archiving });
        toast("success", `Subject <strong>${esc(subject.name)}</strong> ${archiving ? "archived" : "restored"}.`);
        renderSubjectManageList();
      } catch (e) { handleApiError(e, "The subject could not be updated."); }
    }
  }));
}
function renameSubjectFlow(subject) {
  pushModal((root) => {
    root.innerHTML = `
      ${modalHead("Manage subjects", "Rename “" + subject.name + "”")}
      <div class="modal-body">
        <div class="field"><label for="rs-name">Subject name</label><input id="rs-name" type="text" maxlength="128" value="${esc(subject.name)}" /></div>
        <div class="field"><label for="rs-desc">Description</label><input id="rs-desc" type="text" maxlength="1024" value="${esc(subject.description || "")}" /></div>
        <p class="field-hint">Renaming updates the subject everywhere, including the subject labels on its documents.</p>
      </div>
      <footer class="modal-foot">
        <span class="spacer"></span>
        <button class="btn" type="button" data-rs-cancel>Cancel</button>
        <button class="btn btn-primary" type="button" data-rs-save>Save changes</button>
      </footer>`;
    bindModalChrome(root);
    root.querySelector("[data-rs-cancel]").addEventListener("click", popModal);
    root.querySelector("[data-rs-save]").addEventListener("click", async () => {
      const name = $("#rs-name", root).value.trim();
      if (!name) { toast("error", "The subject needs a name."); return; }
      try {
        await state.api.updateSubject(subject.id, { name, description: $("#rs-desc", root).value.trim() });
        state.allSubjects = await state.api.listSubjects({ includeArchived: true });
        state.subjects = state.allSubjects.filter(s => !s.archived);
        toast("success", "Subject renamed.");
        popModal();
        if (navKeyFor(parseHash().segs) === "admin-subjects") renderSubjectManageList();
      } catch (e) { handleApiError(e, "The subject could not be renamed."); }
    });
  });
}

/* ----------------------------------------------------------------------------
   23. Document detail modal — preview / download / versions / edit / replace
---------------------------------------------------------------------------- */
function previewable(d) {
  const cat = d.category;
  if (cat === "text") return d.fileSize <= 400 * 1024;
  if (cat === "pdf" || cat === "video") return d.fileSize <= 64 * 1048576;
  if (cat === "image") return d.fileSize <= 24 * 1048576;
  return false;
}
async function openDocModal(docId, focusAction) {
  let doc;
  try { doc = await state.api.getDocument(docId); }
  catch (e) { handleApiError(e, "That document could not be opened."); return; }
  renderDocDetail(doc, focusAction);
}
function renderDocDetail(doc, focusAction) {
  pushModal((root) => {
    const starred = state.stars.has(doc.id);
    root.innerHTML = `
      ${modalHead(doc.subjectName || "Unassigned", doc.title, doc.category)}
      <div class="modal-body">
        ${doc.description ? `<p class="modal-desc">${esc(doc.description)}</p>` : ""}
        <div class="detail-grid">
          <div class="detail-cell"><div class="k">File type</div><div class="v">${esc(fileLabel(doc.fileName))}</div></div>
          <div class="detail-cell"><div class="k">Size</div><div class="v">${esc(fmtBytes(doc.fileSize))}</div></div>
          <div class="detail-cell"><div class="k">Added</div><div class="v">${esc(fmtDate(doc.createdAt))}</div></div>
          <div class="detail-cell"><div class="k">Updated</div><div class="v">${esc(fmtDate(doc.updatedAt))}</div></div>
          <div class="detail-cell"><div class="k">Version</div><div class="v">v${esc(doc.version)}</div></div>
          <div class="detail-cell"><div class="k">File name</div><div class="v">${esc(doc.fileName)}</div></div>
        </div>
        ${(doc.tags && doc.tags.length) ? `<div class="doc-tags" style="margin-bottom:14px">${doc.tags.map(t => `<span class="chip chip-teal">${esc(t)}</span>`).join("")}</div>` : ""}
        <div id="doc-modal-msg"></div>
      </div>
      <footer class="modal-foot">
        <button class="star-btn ${starred ? "is-starred" : ""}" data-star="${esc(doc.id)}" type="button" aria-pressed="${starred}" aria-label="${starred ? "Remove from starred" : "Add to starred"}" style="width:40px;height:40px;border-color:var(--line)">${icon(starred ? "star-fill" : "star")}</button>
        ${previewable(doc) ? `<button class="btn btn-teal" type="button" data-act="preview">${icon("eye")}<span>Preview</span></button>` : ""}
        <button class="btn btn-primary" type="button" data-act="download">${icon("download")}<span>Download</span></button>
        ${state.isAdmin ? `
          <span class="spacer"></span>
          <button class="btn" type="button" data-act="edit">${icon("edit")}<span>Edit</span></button>
          <button class="btn" type="button" data-act="replace">${icon("swap")}<span>Replace file</span></button>
          <button class="btn" type="button" data-act="versions">${icon("history")}<span>Versions</span></button>
          <button class="btn btn-danger" type="button" data-act="delete">${icon("trash")}<span>Delete</span></button>` : ""}
      </footer>`;
    bindModalChrome(root);
    root.querySelector("[data-star]").addEventListener("click", () => toggleStar(doc.id));
    const msg = () => $("#doc-modal-msg", root);
    root.querySelector("[data-act='download']").addEventListener("click", async () => {
      try {
        const blob = await state.api.downloadBlob(doc.fileId);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = doc.fileName || "document";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        toast("success", `Downloading <strong>${esc(doc.fileName)}</strong>.`);
      } catch (e) {
        if (demoBlocked(e)) { msg().innerHTML = `<div class="alert alert-info">${icon("info")}<span>${esc(e.userMessage)}</span></div>`; return; }
        try {
          const url = state.api.downloadUrl(doc.fileId);
          window.open(url, "_blank", "noopener");
          msg().innerHTML = `<div class="alert alert-info">${icon("info")}<span>Opened in a new tab — use your browser's download there.</span></div>`;
        } catch (e2) {
          msg().innerHTML = `<div class="alert alert-error">${icon("alert")}<span>${esc(friendlyError(e2, "The download failed."))}</span></div>`;
        }
      }
    });
    root.querySelector("[data-act='preview']")?.addEventListener("click", () => renderDocPreview(doc));
    root.querySelector("[data-act='edit']")?.addEventListener("click", () => renderDocEdit(doc));
    root.querySelector("[data-act='replace']")?.addEventListener("click", () => replaceFileFlow(doc));
    root.querySelector("[data-act='versions']")?.addEventListener("click", () => renderDocVersions(doc));
    root.querySelector("[data-act='delete']")?.addEventListener("click", () => deleteDocumentFlow(doc.id));
    if (focusAction === "edit") root.querySelector("[data-act='edit']")?.click();
  });
}

/* Preview — safe content handling: sandboxed iframe, img, video or text; uploaded
   files are never executed in the application origin and HTML is never rendered. */
function renderDocPreview(doc) {
  pushModal((root) => {
    root.innerHTML = `
      ${modalHead(doc.subjectName || "", doc.title, doc.category)}
      <div class="modal-body">
        <div id="preview-host"><div class="loading-block"><span class="spinner"></span>Preparing preview…</div></div>
        <p class="preview-note">${icon("info")}<span>Previews run in a sandboxed frame — uploaded files are never executed by this application. Unsupported formats offer a download instead.</span></p>
      </div>
      <footer class="modal-foot">
        <button class="btn" type="button" data-back>‹ Back to details</button>
        <span class="spacer"></span>
        <button class="btn btn-primary" type="button" data-dl>${icon("download")}<span>Download</span></button>
      </footer>`;
    bindModalChrome(root);
    root.querySelector("[data-back]").addEventListener("click", popModal);
    root.querySelector("[data-dl]").addEventListener("click", async () => {
      try {
        const blob = await state.api.downloadBlob(doc.fileId);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = doc.fileName || "document";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (e) { toast("error", esc(friendlyError(e, "The download failed."))); }
    });

    const host = $("#preview-host", root);
    (async () => {
      try {
        const blob = await state.api.fileBlob(doc.fileId);
        const url = trackBlob(URL.createObjectURL(blob));
        if (doc.category === "image") {
          host.innerHTML = `<img class="preview-media" src="${url}" alt="Preview of ${esc(doc.title)}" />`;
        } else if (doc.category === "video") {
          host.innerHTML = `<video class="preview-media" controls preload="metadata" src="${url}"></video>`;
        } else if (doc.category === "pdf") {
          host.innerHTML = `<iframe class="preview-frame" sandbox="" title="PDF preview of ${esc(doc.title)}" src="${url}"></iframe>`;
        } else if (doc.category === "text") {
          const text = await blob.text();
          const pre = document.createElement("pre");
          pre.className = "preview-text";
          pre.textContent = text.slice(0, 200000);
          host.innerHTML = "";
          host.appendChild(pre);
        } else {
          host.innerHTML = `<div class="empty"><div class="empty-art">${emptyArt("noResults")}</div><p class="empty-title">No preview available</p><p class="empty-desc">This format cannot be previewed safely — download it instead.</p></div>`;
        }
      } catch (e) {
        if (demoBlocked(e)) {
          host.innerHTML = `<div class="empty"><div class="empty-art">${emptyArt("offline")}</div><p class="empty-title">Preview needs a real backend</p><p class="empty-desc">${esc(e.userMessage)}</p></div>`;
          return;
        }
        host.innerHTML = `<div class="empty"><div class="empty-art">${emptyArt("offline")}</div><p class="empty-title">Preview unavailable</p><p class="empty-desc">${esc(friendlyError(e, "The file could not be loaded for preview."))}</p>
          <div class="empty-actions"><button class="btn btn-primary" type="button" data-dl2>${icon("download")}<span>Download instead</span></button></div></div>`;
        host.querySelector("[data-dl2]")?.addEventListener("click", () => root.querySelector("[data-dl]").click());
      }
    })();
  }, { wide: true });
}

/* Edit metadata */
function renderDocEdit(doc) {
  pushModal((root) => {
    const subjectOpts = state.allSubjects.map(s => `<option value="${esc(s.id)}" ${s.id === doc.subjectId ? "selected" : ""}>${esc(s.name)}${s.archived ? " (archived)" : ""}</option>`).join("");
    root.innerHTML = `
      ${modalHead("Edit document", doc.title, doc.category)}
      <div class="modal-body">
        <div class="field"><label for="de-title">Title</label><input id="de-title" type="text" maxlength="256" value="${esc(doc.title)}" /></div>
        <div class="field"><label for="de-desc">Description</label><textarea id="de-desc" maxlength="2048">${esc(doc.description)}</textarea></div>
        <div class="field"><label for="de-subject">Subject</label><select id="de-subject">${subjectOpts}</select></div>
        <div class="field"><label for="de-tags">Tags (comma separated)</label><input id="de-tags" type="text" value="${esc((doc.tags || []).join(", "))}" /></div>
        <div id="de-msg"></div>
      </div>
      <footer class="modal-foot">
        <span class="spacer"></span>
        <button class="btn" type="button" data-cancel>Cancel</button>
        <button class="btn btn-primary" type="button" data-save>Save changes</button>
      </footer>`;
    bindModalChrome(root);
    root.querySelector("[data-cancel]").addEventListener("click", popModal);
    root.querySelector("[data-save]").addEventListener("click", async () => {
      const title = $("#de-title", root).value.trim();
      if (!title) { toast("error", "The document needs a title."); return; }
      const subjectId = $("#de-subject", root).value;
      const subject = state.allSubjects.find(s => s.id === subjectId) || { name: doc.subjectName };
      const tags = $("#de-tags", root).value.split(",").map(t => t.trim()).filter(Boolean).slice(0, 10).map(t => t.slice(0, 64));
      const description = $("#de-desc", root).value.trim();
      const patch = {
        title, description, subjectId, subjectName: subject.name, tags,
        searchText: buildSearchText([title, description, subject.name, fileLabel(doc.fileName), tags.join(" "), doc.fileName])
      };
      try {
        const updated = await state.api.updateDocument(doc.id, patch);
        toast("success", "Document details saved.");
        popModal();
        rerenderSoft();
        void updated;
      } catch (e) {
        $("#de-msg", root).innerHTML = `<div class="alert alert-error">${icon("alert")}<span>${esc(friendlyError(e, "The changes could not be saved."))}</span></div>`;
      }
    });
  });
}

/* Replace file — preserves history via a version record of the outgoing file */
function replaceFileFlow(doc) {
  state.filePickerMode = "replace";
  state.replaceContext = { docId: doc.id };
  dom.fileInput.value = "";
  dom.fileInput.multiple = false;
  dom.fileInput.click();
  dom.fileInput.multiple = true;
}
async function handleReplaceFile(docId, file) {
  const ext = extOf(file.name);
  const maxBytes = FOLIO_ADVANCED.maxFileSizeMB * 1048576;
  if (!EXT_META[ext]) { toast("error", `“.${ext || "?"}” files are not allowed.`); return; }
  if (file.size > maxBytes) { toast("error", `File exceeds the ${FOLIO_ADVANCED.maxFileSizeMB} MB limit.`); return; }
  let doc;
  try { doc = await state.api.getDocument(docId); }
  catch (e) { handleApiError(e, "Document not found."); return; }

  pushModal((root) => {
    root.innerHTML = `
      ${modalHead("Replace file", doc.title, doc.category)}
      <div class="modal-body">
        <p style="margin-bottom:12px">Replacing <strong>${esc(doc.fileName)}</strong> (${esc(fmtBytes(doc.fileSize))}) with <strong>${esc(file.name)}</strong> (${esc(fmtBytes(file.size))}).</p>
        <p class="field-hint" style="margin-bottom:12px">The current file is preserved as version ${esc(doc.version)} in the document's history. The replacement becomes version ${esc(doc.version + 1)}.</p>
        <div id="rp-progress" class="q-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="q-fill" style="width:0%"></div></div>
        <div id="rp-msg" style="margin-top:12px"></div>
      </div>
      <footer class="modal-foot">
        <span class="spacer"></span>
        <button class="btn" type="button" data-cancel disabled>Close</button>
      </footer>`;
    bindModalChrome(root);
    const fill = $("#rp-progress .q-fill", root);
    (async () => {
      try {
        const { fileId, promise } = state.api.uploadFile(file, (pct) => {
          fill.style.width = pct + "%";
          $("#rp-progress", root).setAttribute("aria-valuenow", String(pct));
        });
        await promise;
        $("#rp-msg", root).innerHTML = `<div class="alert alert-info">${icon("info")}<span>File stored — recording version history…</span></div>`;
        const existingVersions = await state.api.listVersions(doc.id);
        if (!existingVersions.some(v => v.versionNumber === doc.version)) {
          await state.api.createVersion({
            documentId: doc.id, fileId: doc.fileId, fileName: doc.fileName, mimeType: doc.mimeType,
            fileSize: doc.fileSize, versionNumber: doc.version,
            changeNote: "Original file, preserved on replacement", createdBy: state.user.id
          });
        }
        const cat = fileCat(file.name, file.type);
        const mime = EXT_META[ext]?.mime || file.type || "application/octet-stream";
        await state.api.updateDocument(doc.id, {
          fileId, fileName: file.name, mimeType: mime, category: cat, fileSize: file.size,
          version: doc.version + 1,
          searchText: buildSearchText([doc.title, doc.description, doc.subjectName, EXT_META[ext]?.label || "", (doc.tags || []).join(" "), file.name])
        });
        toast("success", `<strong>${esc(doc.title)}</strong> now serves the new file (v${doc.version + 1}).`);
        popModal();
        rerenderSoft();
      } catch (e) {
        $("#rp-msg", root).innerHTML = `<div class="alert alert-error">${icon("alert")}<span>${esc(friendlyError(e, "The replacement failed. The original file is untouched."))}</span></div>`;
        const cancelBtn = root.querySelector("[data-cancel]");
        cancelBtn.disabled = false;
      }
    })();
  });
}

/* Version history */
async function renderDocVersions(doc) {
  let versions = [];
  try { versions = await state.api.listVersions(doc.id); }
  catch (e) { toast("error", esc(friendlyError(e, "Version history could not be loaded."))); return; }
  pushModal((root) => {
    root.innerHTML = `
      ${modalHead("Version history", doc.title, doc.category)}
      <div class="modal-body">
        <p class="field-hint" style="margin-bottom:12px">Version ${esc(doc.version)} (file <code>${esc(doc.fileId)}</code>) is currently served to readers.</p>
        <div class="version-list">
          ${versions.length ? versions.map(v => `
            <div class="version-row" data-vid="${esc(v.id)}">
              <span class="v-num">v${esc(v.versionNumber)}</span>
              <span class="v-meta">${esc(v.fileName)} · ${esc(fmtBytes(v.fileSize))} · ${esc(fmtDate(v.createdAt))}</span>
              <span class="v-actions">
                <button class="btn btn-sm" type="button" data-v-action="restore">${icon("swap")}<span>Restore</span></button>
                <button class="btn btn-sm btn-danger" type="button" data-v-action="delete">${icon("trash")}<span>Delete</span></button>
              </span>
              ${v.changeNote ? `<span class="v-note">${esc(v.changeNote)}</span>` : ""}
            </div>`).join("")
          : `<div class="empty" style="padding:26px"><p class="empty-title">No archived versions</p><p class="empty-desc">When you replace this file, the outgoing version is preserved here.</p></div>`}
        </div>
        <div id="vh-msg" style="margin-top:12px"></div>
      </div>
      <footer class="modal-foot">
        <button class="btn" type="button" data-back>‹ Back to details</button>
        <span class="spacer"></span>
        <button class="btn btn-primary" type="button" data-reload>${icon("refresh")}<span>Refresh</span></button>
      </footer>`;
    bindModalChrome(root);
    root.querySelector("[data-back]").addEventListener("click", popModal);
    root.querySelector("[data-reload]").addEventListener("click", () => { popModal(); renderDocVersions(doc); });
    root.querySelectorAll("[data-v-action]").forEach(b => b.addEventListener("click", async () => {
      const vid = b.closest("[data-vid]").dataset.vid;
      const v = versions.find(x => x.id === vid);
      if (!v) return;
      if (b.dataset.vAction === "restore") {
        const ok = await confirmDialog({
          title: `Restore version ${v.versionNumber}?`,
          body: `Readers will receive <strong>${esc(v.fileName)}</strong> (${esc(fmtBytes(v.fileSize))}) again. The current file (v${esc(doc.version)}) remains in storage and in this history.`,
          confirmLabel: "Restore version"
        });
        if (!ok) return;
        try {
          await state.api.updateDocument(doc.id, {
            fileId: v.fileId, fileName: v.fileName, mimeType: v.mimeType, fileSize: v.fileSize,
            category: fileCat(v.fileName, v.mimeType), version: v.versionNumber
          });
          toast("success", `Version ${v.versionNumber} restored as the current file.`);
          popModal(); rerenderSoft();
        } catch (e) { $("#vh-msg", root).innerHTML = `<div class="alert alert-error">${icon("alert")}<span>${esc(friendlyError(e))}</span></div>`; }
      } else {
        const ok = await confirmDialog({
          title: `Delete archived version ${v.versionNumber}?`,
          body: "The archived copy and its stored file will be removed permanently. The current file is not affected.",
          confirmLabel: "Delete version", danger: true
        });
        if (!ok) return;
        try {
          await state.api.deleteVersion(v.id, v.fileId);
          toast("success", `Version ${v.versionNumber} deleted.`);
          popModal(); renderDocVersions(doc);
        } catch (e) { $("#vh-msg", root).innerHTML = `<div class="alert alert-error">${icon("alert")}<span>${esc(friendlyError(e))}</span></div>`; }
      }
    }));
  });
}

/* Delete document — removes record, version records and stored files */
async function deleteDocumentFlow(docId) {
  let doc;
  try { doc = await state.api.getDocument(docId); }
  catch (e) { handleApiError(e, "That document could not be found."); return; }
  let versions = [];
  try { versions = await state.api.listVersions(docId); } catch { versions = []; }
  const ok = await confirmDialog({
    title: `Delete “${doc.title}”?`,
    body: `This permanently removes the document record, its ${versions.length + 1} stored file${versions.length ? "s (including archived versions)" : ""} and any starred references. This action cannot be undone.`,
    confirmLabel: "Delete permanently", danger: true
  });
  if (!ok) return;
  try {
    await state.api.deleteDocument(doc.id);
    for (const v of versions) await state.api.deleteVersion(v.id, v.fileId);
    await state.api.deleteFile(doc.fileId);
    state.stars.delete(doc.id);
    toast("success", `<strong>${esc(doc.title)}</strong> was deleted.`);
    closeModal();
    rerenderSoft();
  } catch (e) {
    handleApiError(e, "The document could not be fully deleted. Remove any remaining versions from the version history.");
  }
}
/* Refresh whichever list is on screen after a mutation */
function rerenderSoft() {
  const key = navKeyFor(parseHash().segs);
  if (key === "admin-documents" || key === "admin-subjects") route();
  else if (key === "library") refreshLibraryResults();
  else route();
}

/* ----------------------------------------------------------------------------
   24. File input dispatch (upload queue vs replace flow)
---------------------------------------------------------------------------- */
function bindFileInput() {
  dom.fileInput.addEventListener("change", () => {
    const files = Array.from(dom.fileInput.files || []);
    if (!files.length) return;
    if (state.filePickerMode === "replace" && state.replaceContext) {
      const { docId } = state.replaceContext;
      state.replaceContext = null;
      handleReplaceFile(docId, files[0]);
    } else {
      if (state.demo) { toast("info", "Preview mode — file uploads need a connected backend."); return; }
      enqueueFiles(files);
    }
  });
}

/* ----------------------------------------------------------------------------
   25. Boot
---------------------------------------------------------------------------- */
function bindLogin() {
  dom.loginYear.textContent = String(new Date().getFullYear());
  dom.loginForm.addEventListener("submit", doLogin);
  dom.pwToggle.addEventListener("click", () => {
    const show = dom.loginPassword.type === "password";
    dom.loginPassword.type = show ? "text" : "password";
    dom.pwToggle.textContent = show ? "Hide" : "Show";
    dom.pwToggle.setAttribute("aria-pressed", String(show));
    dom.pwToggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
  });
}

async function boot() {
  cacheDom();
  bindShell();
  setupModal();
  bindLogin();
  bindFileInput();
  loadFilterPrefs();
  window.addEventListener("hashchange", route);

  const st = configStatus();
  if (!st.ok) { renderConfigScreen(); return; }
  if (!(await ensureAppwriteSdk())) { renderConfigScreen({ sdkMissing: true }); return; }

  state.api = createRealApi();
  try {
    await loadSessionData();
    dom.loginView.hidden = true;
    dom.configView.hidden = true;
    dom.shell.hidden = false;
    if (!location.hash || location.hash === "#/" || location.hash === "#/login") {
      history.replaceState(null, "", "#/dashboard");
    }
    await route();
  } catch (e) {
    console.warn("[Folio] session restore failed:", e);
    resetAppState();
    showLogin();
  }
}

boot();
