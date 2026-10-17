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

/**
 * @param {HTMLElement} host      where to draw the viewer
 * @param {object} options
 * @param {Array<{label: string, load: () => Promise<Uint8Array>}>} options.docs  the contract files, in order
 * @param {string} options.signedName  shown inside the signature marker
 * @param {string} options.dateText    shown at the date marker (for example "18 Oct 2026")
 * @param {() => void} [options.onChange]
 */
export async function createPlacer(host, { docs, signedName, dateText, onChange = () => {} }) {
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

  const state = { index: pages.length - 1, mode: "signature", signature: null, date: null, markedPage: null };
  host.innerHTML = `
    <div class="placer-bar">
      <div class="placer-modes" role="group" aria-label="What to place">
        <button type="button" class="secondary-action small" data-mode="signature" aria-pressed="true">Place signature</button>
        <button type="button" class="secondary-action small" data-mode="date" aria-pressed="false">Place date</button>
        <button type="button" class="text-button" data-clear-date hidden>Remove date</button>
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
  let scale = 1, drawing = 0;

  const modeButtons = [...host.querySelectorAll("[data-mode]")];
  const setMode = mode => {
    state.mode = mode;
    modeButtons.forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    hint.textContent = mode === "signature"
      ? "Click on the signature line where the signature should start. The dashed box shows its size."
      : "Click on the date line where the date should start.";
  };

  const drawMarkers = () => {
    layer.innerHTML = "";
    if (state.markedPage !== state.index) return;
    const box = (cls, left, top, w, h, text) => {
      const el = document.createElement("div");
      el.className = `placer-mark ${cls}`;
      Object.assign(el.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` });
      el.innerHTML = `<span>${esc(text)}</span>`;
      layer.appendChild(el);
    };
    const [w, h] = [canvas.clientWidth, canvas.clientHeight];
    if (state.signature) {
      const [bw, bh] = [SIGN_W * scale, SIGN_H * scale];
      box("placer-signature", state.signature.x * w + 2 * scale, state.signature.y * h - bh - 3 * scale, bw, bh, signedName);
    }
    if (state.date) {
      const bh = 14 * scale;
      box("placer-date", state.date.x * w + 2 * scale, state.date.y * h - bh - 2 * scale, 78 * scale, bh, dateText);
    }
    host.querySelector("[data-clear-date]").hidden = !state.date;
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
      else if ("clearDate" in button.dataset) { state.date = null; drawMarkers(); onChange(); }
      return;
    }
    if (!event.target.closest(".placer-stage")) return;
    const rect = canvas.getBoundingClientRect();
    const point = {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
    };
    // The signature and the date go on the same page: marking a new page starts again.
    if (state.markedPage !== state.index) { state.signature = null; state.date = null; state.markedPage = state.index; setMode("signature"); }
    state[state.mode] = point;
    if (state.mode === "signature" && !state.date) setMode("date");
    drawMarkers();
    onChange();
  });

  setMode("signature");
  await render();

  return {
    /** The placement to send to the server, or null until the signature has been placed. */
    getPlacement() {
      if (!state.signature || state.markedPage === null) return null;
      return { page: state.markedPage + 1, signature: state.signature, date: state.date };
    },
    pageCount: pages.length
  };
}
