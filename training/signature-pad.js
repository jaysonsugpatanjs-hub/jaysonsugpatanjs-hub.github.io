// A box to write a signature in, for mouse, touch and pen (pointer events).
// Used for the applicant's signature on the portal and for HR's counter-signature.
const attached = new WeakMap();

/** Makes `canvas` writable. Returns { isDirty, clear, toDataURL }, or null if the browser can't draw. */
export function attachPad(canvas) {
  if (attached.has(canvas)) return attached.get(canvas);
  const ctx = canvas.getContext?.("2d");
  if (!ctx) return null;
  const state = { drawing: false, last: null, dirty: false };
  const paper = () => { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); };
  paper();
  ctx.strokeStyle = "#101014";
  ctx.lineWidth = 3.2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const point = event => {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * (canvas.width / rect.width), y: (event.clientY - rect.top) * (canvas.height / rect.height) };
  };
  canvas.addEventListener("pointerdown", event => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    canvas.setPointerCapture?.(event.pointerId);
    state.drawing = true;
    state.last = point(event);
    // A tap leaves a dot.
    ctx.beginPath();
    ctx.arc(state.last.x, state.last.y, 1.6, 0, Math.PI * 2);
    ctx.fillStyle = "#101014";
    ctx.fill();
    state.dirty = true;
  });
  canvas.addEventListener("pointermove", event => {
    if (!state.drawing) return;
    event.preventDefault();
    const next = point(event);
    ctx.beginPath();
    ctx.moveTo(state.last.x, state.last.y);
    ctx.lineTo(next.x, next.y);
    ctx.stroke();
    state.last = next;
  });
  const stop = () => { state.drawing = false; };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);
  const pad = {
    isDirty: () => state.dirty,
    clear() { paper(); state.dirty = false; },
    toDataURL: () => canvas.toDataURL("image/png")
  };
  attached.set(canvas, pad);
  return pad;
}
