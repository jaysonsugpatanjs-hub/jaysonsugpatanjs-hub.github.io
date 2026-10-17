import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { inkOnTransparent } from "../../supabase/functions/_shared/png-ink.ts";

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), 8 + data.length);
  return out;
};
const paeth = (a: number, b: number, c: number) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };

/** Encodes pixels as a PNG, using a different row filter on each row so unfiltering is exercised. */
function encode(width: number, height: number, bpp: 3 | 4, pixel: (x: number, y: number) => number[], depth = 8) {
  const stride = width * bpp;
  const rows = Array.from({ length: height }, (_, y) => Buffer.from(Array.from({ length: width }, (_, x) => pixel(x, y).slice(0, bpp)).flat()));
  const raw: number[] = [];
  rows.forEach((row, y) => {
    const f = y % 5, prev = y ? rows[y - 1] : Buffer.alloc(stride);
    raw.push(f);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      raw.push((row[i] - (f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? ((a + b) >> 1) : paeth(a, b, c)) + 256) & 255);
    }
  });
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr.set([depth, bpp === 4 ? 6 : 2, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.from(raw))), chunk("IEND", Buffer.alloc(0))]));
}

/** Reads back an RGBA PNG written with filter 0 (what inkOnTransparent writes). */
function decodeRgba(png: Uint8Array) {
  const buf = Buffer.from(png);
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
  assert.equal(buf[24], 8, "8-bit"); assert.equal(buf[25], 6, "RGBA");
  let at = 8; const idat: Buffer[] = [];
  while (at < buf.length) { const len = buf.readUInt32BE(at), type = buf.toString("latin1", at + 4, at + 8); if (type === "IDAT") idat.push(buf.subarray(at + 8, at + 8 + len)); at += 12 + len; }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const at4 = (x: number, y: number) => { const o = y * (width * 4 + 1); assert.equal(raw[o], 0, "filter 0"); const p = o + 1 + x * 4; return [raw[p], raw[p + 1], raw[p + 2], raw[p + 3]]; };
  return { width, height, at4 };
}

const W = 40, H = 20;
const strokeAt = (x: number, y: number) => (y === 10 && x >= 5 && x < 30 ? "ink" : x === 35 && y === 5 ? "edge" : "paper");
const rgba = (x: number, y: number) => ({ ink: [20, 20, 90, 255], edge: [128, 128, 128, 255], paper: [255, 255, 255, 255] }[strokeAt(x, y)]);

test("a signature box becomes ink on a transparent background", async () => {
  const out = decodeRgba(await inkOnTransparent(encode(W, H, 4, rgba)));
  assert.equal(out.width, W); assert.equal(out.height, H);
  assert.deepEqual(out.at4(0, 0), [0, 0, 0, 0], "paper is fully transparent");
  assert.deepEqual(out.at4(39, 19), [0, 0, 0, 0]);
  const ink = out.at4(10, 10);
  assert.equal(ink[3], 255, "ink is fully opaque");
  assert.ok(ink[2] > ink[0] + 40, "the ink keeps its blue");
  const edge = out.at4(35, 5);
  assert.ok(edge[3] > 100 && edge[3] < 200, `anti-aliased grey becomes see-through ink, got alpha ${edge[3]}`);
  assert.ok(edge[0] < 4 && edge[1] < 4 && edge[2] < 4, "of the darkest ink");
});

test("RGB images (no alpha channel) work too", async () => {
  const out = decodeRgba(await inkOnTransparent(encode(W, H, 3, rgba)));
  assert.deepEqual(out.at4(0, 0), [0, 0, 0, 0]);
  assert.equal(out.at4(10, 10)[3], 255);
});

test("anything it can't read comes back unchanged", async () => {
  const notPng = new Uint8Array([1, 2, 3, 4, 5]);
  assert.equal(await inkOnTransparent(notPng), notPng);
  const sixteen = encode(W, H, 4, rgba, 16);
  assert.equal(await inkOnTransparent(sixteen), sixteen, "16-bit is left alone");
  const truncated = encode(W, H, 4, rgba).slice(0, 60);
  assert.equal(await inkOnTransparent(truncated), truncated);
});
