// Minimal stand-in for pdf-lib: records drawn text so tests can check PDF content.
export const pdfText: string[] = [];
/** Every text and image drawn, with where it went (PDF points), so tests can check placement. */
export const pdfDraws: { text?: string; image?: boolean; x: number; y: number; width?: number; height?: number }[] = [];
const font = { widthOfTextAtSize: (t: string, size: number) => t.length * size * 0.5 };
const page = () => ({
  getWidth: () => 595, getHeight: () => 842,
  drawText: (t: string, o: any = {}) => { pdfText.push(t); pdfDraws.push({ text: t, x: o.x, y: o.y }); },
  drawRectangle: () => {}, drawLine: () => {},
  drawImage: (_i: unknown, o: any = {}) => { pdfDraws.push({ image: true, x: o.x, y: o.y, width: o.width, height: o.height }); }
});
export const PDFDocument: any = {
  // Any bytes that start with %PDF- load as a two-page document; anything else fails, like a damaged file.
  load: async (bytes: Uint8Array) => {
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new Error("not a PDF");
    return { getPageIndices: () => [0, 1] };
  },
  create: async () => {
    const pages: any[] = [];
    return {
      setTitle: () => {}, setAuthor: () => {},
      embedFont: async () => font, embedJpg: async () => ({ scale: () => ({ width: 1, height: 1 }) }), embedPng: async () => ({ width: 300, height: 100, scale: () => ({ width: 1, height: 1 }) }),
      addPage: () => { const p = page(); pages.push(p); return p; },
      getPages: () => pages, getPageCount: () => pages.length,
      copyPages: async (_source: unknown, indices: number[]) => indices.map(() => ({})),
      save: async () => new TextEncoder().encode("%PDF-stub\n" + pdfText.join("\n"))
    };
  }
};
export const StandardFonts: any = { Helvetica: "Helvetica", HelveticaBold: "Helvetica-Bold", TimesRomanItalic: "Times-Italic" };
export const rgb: any = () => ({});
export type PDFFont = any;
