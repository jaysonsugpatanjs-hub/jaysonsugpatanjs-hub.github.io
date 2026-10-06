// Minimal stand-in for pdf-lib: records drawn text so tests can check PDF content.
export const pdfText: string[] = [];
const font = { widthOfTextAtSize: (t: string, size: number) => t.length * size * 0.5 };
const page = () => ({
  getWidth: () => 595, getHeight: () => 842,
  drawText: (t: string) => { pdfText.push(t); }, drawRectangle: () => {}, drawLine: () => {}, drawImage: () => {}
});
export const PDFDocument: any = {
  create: async () => {
    const pages: any[] = [];
    return {
      setTitle: () => {}, setAuthor: () => {},
      embedFont: async () => font, embedJpg: async () => ({ scale: () => ({ width: 1, height: 1 }) }),
      addPage: () => { const p = page(); pages.push(p); return p; },
      getPages: () => pages,
      save: async () => new TextEncoder().encode(pdfText.join("\n"))
    };
  }
};
export const StandardFonts: any = { Helvetica: "Helvetica", HelveticaBold: "Helvetica-Bold" };
export const rgb: any = () => ({});
export type PDFFont = any;
