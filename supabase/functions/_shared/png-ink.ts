// Turns a handwritten signature (ink on a white box) into ink on a transparent
// background, so stamping it on a contract never blanks out the text around it.
// The stored original is not changed; this is used only when stamping.
//
// Handles what browsers produce: 8-bit RGB or RGBA, not interlaced. Anything
// else is returned as it came, which is still a perfectly good (opaque) image.

const stream = async (bytes: Uint8Array, transform: CompressionStream | DecompressionStream) => {
  const writer = transform.writable.getWriter();
  // A damaged stream fails when read below; these would only report it a second time.
  writer.write(new Uint8Array(bytes)).catch(() => {});
  writer.close().catch(() => {});
  return new Uint8Array(await new Response(transform.readable).arrayBuffer());
};

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return (bytes: Uint8Array) => { let c = 0xffffffff; for (const b of bytes) c = table[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
})();

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, CRC(out.subarray(4, 8 + data.length)));
  return out;
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export async function inkOnTransparent(png: Uint8Array): Promise<Uint8Array> {
  try {
    const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (!magic.every((b, i) => png[i] === b)) return png;
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    let width = 0, height = 0, depth = 0, color = 0, interlace = 1;
    const parts: Uint8Array[] = [];
    for (let at = 8; at + 12 <= png.length;) {
      const length = view.getUint32(at);
      const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
      const data = png.subarray(at + 8, at + 8 + length);
      if (type === "IHDR") { width = view.getUint32(at + 8); height = view.getUint32(at + 12); depth = data[8]; color = data[9]; interlace = data[12]; }
      else if (type === "IDAT") parts.push(data);
      else if (type === "IEND") break;
      at += 12 + length;
    }
    if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6) || !width || !height || width * height > 4_000_000) return png;
    const bpp = color === 6 ? 4 : 3, stride = width * bpp;
    const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) { joined.set(p, off); off += p.length; }
    const raw = await stream(joined, new DecompressionStream("deflate"));
    if (raw.length !== height * (stride + 1)) return png;

    // Undo the row filters.
    const px = new Uint8Array(height * stride);
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, prev = row - stride;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? px[row + i - bpp] : 0, b = y ? px[prev + i] : 0, c = y && i >= bpp ? px[prev + i - bpp] : 0;
        const v = raw[src + i];
        px[row + i] = filter === 0 ? v : filter === 1 ? v + a : filter === 2 ? v + b : filter === 3 ? v + ((a + b) >> 1) : filter === 4 ? v + paeth(a, b, c) : -1;
      }
      if (filter > 4) return png;
    }

    // Colour to alpha: the lightest channel says how much "paper" shows through.
    const out = new Uint8Array(height * (width * 4 + 1));
    for (let y = 0; y < height; y++) {
      out[y * (width * 4 + 1)] = 0;
      for (let x = 0; x < width; x++) {
        const s = y * stride + x * bpp, d = y * (width * 4 + 1) + 1 + x * 4;
        const [r, g, b] = [px[s], px[s + 1], px[s + 2]];
        const sourceAlpha = bpp === 4 ? px[s + 3] / 255 : 1;
        const paper = Math.min(r, g, b);
        const a = 1 - paper / 255; // how much ink this pixel has
        // Pen strokes read as solid ink; only the soft edges stay see-through.
        const alpha = Math.min(1, a / 0.85) * sourceAlpha;
        if (alpha <= 0.004) continue; // stays fully transparent
        out[d] = Math.max(0, Math.round((r - paper) / a)); out[d + 1] = Math.max(0, Math.round((g - paper) / a)); out[d + 2] = Math.max(0, Math.round((b - paper) / a));
        out[d + 3] = Math.round(alpha * 255);
      }
    }
    const ihdr = new Uint8Array(13), iv = new DataView(ihdr.buffer);
    iv.setUint32(0, width); iv.setUint32(4, height); ihdr.set([8, 6, 0, 0, 0], 8);
    const idat = await stream(out, new CompressionStream("deflate"));
    const pieces = [new Uint8Array(magic), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
    const result = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of pieces) { result.set(p, at); at += p.length; }
    return result;
  } catch (error) {
    console.error("signature image left as it was", error);
    return png;
  }
}
