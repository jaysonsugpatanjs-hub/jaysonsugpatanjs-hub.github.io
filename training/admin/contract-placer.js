// Shows the contract's pages so HR can click where the signature and the date
// go (on the signature line and the date line). Pages are drawn with pdf.js,
// which is shipped with the site (training/vendor/pdfjs) because the page's
// content security policy only allows scripts from this site.
//
// Positions are kept as fractions of the page, measured from its top-left
// corner, so they don't depend on how big the page is drawn. The same
// fractions go to the server, which places the signature on the real PDF.

const PDFJS = new URL("../vendor/pdfjs/pdf.min.js", import.meta.url).href;
const WORKER = new URL("../vendor/pdfjs/pdf.worker.min.js", import.meta.url).href;

// How big the signature is stamped (PDF points). Keep in step with
// supabase/functions/_shared/signed-contract-pdf.ts.
const SIGN_W = 130;
const SIGN_H = 40;

let loading = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = PDFJS;
      script.onload = () => {
        if (!window.pdfjsLib) return reject(new Error("The page viewer could not start."));
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER;
        resolve(window.pdfjsLib);
      };
      script.onerror = () => { loading = null; reject(new Error("The page viewer could not be loaded.")); };
      document.head.appendChild(script);
    });
  }
  return loading;
}

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const MARKS = {
  signature: { kind: "signature", cls: "placer-signature", hint: "Click on the applicant's signature line, where the signature should start. The dashed box shows its size." },
  date: { kind: "date", cls: "placer-date", hint: "Click on the applicant's date line, where the date should start." },
  companySignature: { kind: "signature", cls: "placer-company", hint: "Click on Panalo's signature line, where Panalo's signature should start." },
  companyDate: { kind: "date", cls: "placer-company placer-date", hint: "Click on Panalo's date line, where the date should start." }
};
const NEXT = { signature: "date", companySignature: "companyDate" };

/**
 * @param {HTMLElement} host      where to draw the viewer
 * @param {object} options
 * @param {Array<{label: string, load: () => Promise<Uint8Array>}>} options.docs  the contract files, in order
 * @param {string} options.signedName  shown inside the applicant's signature marker
 * @param {string} options.dateText    shown at the applicant's date marker (for example "18 Oct 2026")
 * @param {string} [options.companyDateText]  shown at Panalo's date marker (the day HR finalizes)
 * @param {() => void} [options.onChange]
 */
export async function createPlacer(host, { docs, signedName, dateText, companyDateText = dateText, onChange = () => {} }) {
  host.innerHTML = '<p class="muted small">Loading the contract pages…</p>';
  const pdfjs = await loadPdfJs();

  // One entry per page of every file, in the order they are merged.
  const pages = [];
  for (const doc of docs) {
    const data = await doc.load();
    const pdf = await pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: false }).promise;
    for (let n = 1; n <= pdf.numPages; n++) pages.push({ pdf, n, label: doc.label });
  }
  if (!pages.length) throw new Error("The contract has no pages to show.");

  // Panalo's counter-signature is optional; HR turns it on with setCompany().
  const state = { index: pages.length - 1, mode: "signature", marks: {}, markedPage: null, company: null };
  host.innerHTML = `
    <div class="placer-bar">
      <div class="placer-modes" role="group" aria-label="What to place">
        <button type="button" class="secondary-action small" data-mode="signature" aria-pressed="true">Applicant signature</button>
        <button type="button" class="secondary-action small" data-mode="date" aria-pressed="false">Applicant date</button>
        <button type="button" class="secondary-action small" data-mode="companySignature" aria-pressed="false" hidden>Panalo signature</button>
        <button type="button" class="secondary-action small" data-mode="companyDate" aria-pressed="false" hidden>Panalo date</button>
        <button type="button" class="text-button" data-clear-mark hidden>Remove this mark</button>
      </div>
      <div class="placer-pages">
        <button type="button" class="secondary-action small" data-prev aria-label="Previous page">‹</button>
        <span data-page-label></span>
        <button type="button" class="secondary-action small" data-next aria-label="Next page">›</button>
      </div>
    </div>
    <p class="muted small" data-hint></p>
    <div class="placer-stage"><canvas data-canvas></canvas><div class="placer-layer" data-layer></div></div>`;
  const canvas = host.querySelector("[data-canvas]");
  const layer = host.querySelector("[data-layer]");
  const hint = host.querySelector("[data-hint]");
  const clearButton = host.querySelector("[data-clear-mark]");
  let scale = 1, drawing = 0;

  const modeButtons = [...host.querySelectorAll("[data-mode]")];
  const setMode = mode => {
    state.mode = mode;
    modeButtons.forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    hint.textContent = MARKS[mode].hint;
    clearButton.hidden = mode === "signature" || !state.marks[mode];
  };

  const drawMarkers = () => {
    layer.innerHTML = "";
    clearButton.hidden = state.mode === "signature" || !state.marks[state.mode];
    if (state.markedPage !== state.index) return;
    const [w, h] = [canvas.clientWidth, canvas.clientHeight];
    for (const [key, spec] of Object.entries(MARKS)) {
      const at = state.marks[key];
      if (!at) continue;
      const signature = spec.kind === "signature";
      const [bw, bh] = signature ? [SIGN_W * scale, SIGN_H * scale] : [78 * scale, 14 * scale];
      const el = document.createElement("div");
      el.className = `placer-mark ${spec.cls}`;
      Object.assign(el.style, {
        left: `${at.x * w + 2 * scale}px`, top: `${at.y * h - bh - (signature ? 3 : 2) * scale}px`, width: `${bw}px`, height: `${bh}px`
      });
      const label = key === "signature" ? signedName : key === "companySignature" ? state.company?.name || "Panalo" : key === "companyDate" ? companyDateText : dateText;
      el.innerHTML = `<span>${esc(label)}</span>`;
      layer.appendChild(el);
    }
  };

  const render = async () => {
    const mine = ++drawing;
    const { pdf, n } = pages[state.index];
    host.querySelector("[data-page-label]").textContent = `Page ${state.index + 1} of ${pages.length}`;
    host.querySelector("[data-prev]").disabled = state.index === 0;
    host.querySelector("[data-next]").disabled = state.index === pages.length - 1;
    const page = await pdf.getPage(n);
    if (mine !== drawing) return;
    const natural = page.getViewport({ scale: 1 });
    const cssWidth = Math.min(host.clientWidth || 720, 720);
    scale = cssWidth / natural.width;
    const ratio = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: scale * ratio });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
    layer.style.width = canvas.style.width;
    layer.style.height = canvas.style.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    if (mine === drawing) drawMarkers();
  };

  const go = async index => {
    state.index = Math.max(0, Math.min(pages.length - 1, index));
    await render();
  };

  host.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (button) {
      if (button.dataset.mode) setMode(button.dataset.mode);
      else if ("prev" in button.dataset) go(state.index - 1);
      else if ("next" in button.dataset) go(state.index + 1);
      else if ("clearMark" in button.dataset) { delete state.marks[state.mode]; drawMarkers(); onChange(); }
      return;
    }
    if (!event.target.closest(".placer-stage")) return;
    const rect = canvas.getBoundingClientRect();
    const point = {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
    };
    // Everything goes on the same page: marking a new page starts again.
    if (state.markedPage !== state.index) { state.marks = {}; state.markedPage = state.index; setMode(state.mode.startsWith("company") ? state.mode : "signature"); }
    state.marks[state.mode] = point;
    const next = NEXT[state.mode];
    if (next && !state.marks[next]) setMode(next);
    drawMarkers();
    onChange();
  });

  setMode("signature");
  await render();

  return {
    /**
     * The placement to send to the server, or null until the applicant's signature has been placed.
     * `company` holds Panalo's marks (or null when there is no counter-signature or it isn't placed yet).
     */
    getPlacement() {
      const m = state.marks;
      if (!m.signature || state.markedPage === null) return null;
      return {
        page: state.markedPage + 1, signature: m.signature, date: m.date ?? null,
        company: state.company && m.companySignature ? { signature: m.companySignature, date: m.companyDate ?? null } : null
      };
    },
    /** Turns Panalo's counter-signature on (with the signatory's name for the marker) or off. */
    setCompany(company) {
      state.company = company;
      for (const key of ["companySignature", "companyDate"]) {
        host.querySelector(`[data-mode="${key}"]`).hidden = !company;
        if (!company) delete state.marks[key];
      }
      if (!company && state.mode.startsWith("company")) setMode("signature");
      drawMarkers();
      onChange();
    },
    pageCount: pages.length
  };
}
