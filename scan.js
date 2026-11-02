/* ============================================================================
   Folio — Scan to PDF (mobile camera → multi-page PDF → upload queue)
   ----------------------------------------------------------------------------
   Adds a "Scan to PDF" option to the upload zone. On phones it opens the
   camera (capture="environment"); each shot becomes a downscaled page in a
   tray. "Add to queue" assembles the pages into a REAL PDF file — built
   byte-by-byte right here (JPEG pages embedded as DCTDecode image XObjects,
   one full-bleed page per photo) — and hands it to the normal upload queue
   via the "folio:scan-pdf" event. script.js listens for that event.

   Zero dependencies (no jsPDF/CDN needed) and works offline, matching the
   vendored/no-build philosophy of the rest of Folio.
   ========================================================================== */
(() => {
  if (window.FolioScan) return;

  const MAX_SIDE = 1700;   // downscale camera photos so PDFs stay lean
  const JPEG_Q = 0.72;
  const PAGE_W = 595;      // A4 width in points; height follows photo aspect

  const pages = [];        // { blob, bytes, w, h, url }

  let cameraInput = null;

  /* ---------------- camera pages ---------------- */

  function ensureCameraInput() {
    if (cameraInput) return cameraInput;
    cameraInput = document.createElement("input");
    cameraInput.type = "file";
    // JPEG-first so iOS converts HEIC shots; capture opens the rear camera.
    cameraInput.accept = "image/jpeg,image/png,image/webp";
    cameraInput.setAttribute("capture", "environment");
    cameraInput.multiple = true;
    cameraInput.hidden = true;
    cameraInput.addEventListener("change", async () => {
      const files = Array.from(cameraInput.files || []);
      cameraInput.value = "";
      for (const f of files) await addPageFromFile(f);
      renderTray();
    });
    document.body.appendChild(cameraInput);
    return cameraInput;
  }

  function openCamera() { ensureCameraInput().click(); }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image decode failed"));
      img.src = url;
    });
  }

  async function addPageFromFile(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", JPEG_Q));
      if (!blob) throw new Error("encode failed");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      pages.push({ blob, bytes, w, h, url: URL.createObjectURL(blob) });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /* ---------------- JPEG → PDF assembler ---------------- */

  function buildPdf(list) {
    const chunks = [];
    let offset = 0;
    const offsets = [];
    const enc = new TextEncoder();
    const push = (data) => {
      const u8 = typeof data === "string" ? enc.encode(data) : data;
      chunks.push(u8); offset += u8.length;
    };
    const pageNum = (i) => 3 + 3 * i, contentNum = (i) => 4 + 3 * i, imgNum = (i) => 5 + 3 * i;
    const n = list.length;

    push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A, 0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A])); // %PDF-1.4 + binary marker
    offsets[1] = offset;
    push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
    offsets[2] = offset;
    push(`2 0 obj\n<< /Type /Pages /Kids [${list.map((_, i) => `${pageNum(i)} 0 R`).join(" ")}] /Count ${n} >>\nendobj\n`);

    for (let i = 0; i < n; i++) {
      const p = list[i];
      const W = PAGE_W;
      const H = Math.max(1, Math.round(PAGE_W * p.h / p.w));
      offsets[pageNum(i)] = offset;
      push(`${pageNum(i)} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${imgNum(i)} 0 R >> /ProcSet [/PDF /ImageC] >> /Contents ${contentNum(i)} 0 R >>\nendobj\n`);
      const stream = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q\n`;
      offsets[contentNum(i)] = offset;
      push(`${contentNum(i)} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`);
      offsets[imgNum(i)] = offset;
      push(`${imgNum(i)} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>\nstream\n`);
      push(p.bytes);
      push("\nendstream\nendobj\n");
    }

    const size = 3 + 3 * n; // highest object number + 1
    const xrefAt = offset;
    let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let i = 1; i < size; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
    push(xref);
    push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`);
    return new Blob(chunks, { type: "application/pdf" });
  }

  /* ---------------- tray UI ---------------- */

  function trayHost() { return document.getElementById("scan-tray"); }

  function renderTray() {
    const tray = trayHost();
    if (!tray) return;
    if (!pages.length) { tray.hidden = true; tray.innerHTML = ""; return; }
    tray.hidden = false;
    const total = pages.reduce((s, p) => s + p.blob.size, 0);
    tray.innerHTML = `
      <div class="scan-tray-head">
        <span class="scan-tray-title">Scan</span>
        <span class="scan-tray-size">${pages.length} page${pages.length === 1 ? "" : "s"} · ~${fmt(total)}</span>
        <button class="btn btn-sm" type="button" data-scan-clear>Clear</button>
        <button class="btn btn-primary btn-sm" type="button" data-scan-queue>Add ${pages.length}-page PDF to queue</button>
      </div>
      <div class="scan-thumbs">
        ${pages.map((p, i) => `
          <figure class="scan-thumb">
            <img src="${p.url}" alt="Scanned page ${i + 1}" />
            <button class="scan-thumb-remove" type="button" data-scan-remove="${i}" aria-label="Remove page ${i + 1}">×</button>
            <figcaption>Page ${i + 1}</figcaption>
          </figure>`).join("")}
      </div>`;
  }

  function fmt(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
    if (n >= 1024) return Math.round(n / 1024) + " KB";
    return n + " B";
  }

  function stampName() {
    const d = new Date(), pad = (x) => String(x).padStart(2, "0");
    return `Scan ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}.pdf`;
  }

  async function addToQueue() {
    if (!pages.length) return;
    const blob = buildPdf(pages);
    const file = new File([blob], stampName(), { type: "application/pdf" });
    clearPages();
    window.dispatchEvent(new CustomEvent("folio:scan-pdf", { detail: { file } }));
  }

  function clearPages() {
    for (const p of pages) URL.revokeObjectURL(p.url);
    pages.length = 0;
    renderTray();
  }

  /* ---------------- global delegation (modal renders dynamically) ---------------- */

  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest("#btn-scan")) { openCamera(); return; }
    if (!t.closest("#scan-tray")) return;
    if (t.closest("[data-scan-queue]")) { addToQueue(); return; }
    if (t.closest("[data-scan-clear]")) { clearPages(); return; }
    const rm = t.closest("[data-scan-remove]");
    if (rm) {
      const i = Number(rm.getAttribute("data-scan-remove"));
      if (pages[i]) { URL.revokeObjectURL(pages[i].url); pages.splice(i, 1); renderTray(); }
    }
  });

  window.FolioScan = { openCamera, clearPages, renderTray, _buildPdf: buildPdf, _pages: pages };
})();
