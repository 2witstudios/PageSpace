export interface PDFDocumentProxy {
  numPages: number;
  getPage(pageNum: number): Promise<PDFPageProxy>;
  getMetadata(): Promise<{ info: PDFInfo | null }>;
  /** pdf.js's own canvas factory; in Node it is backed by @napi-rs/canvas. */
  canvasFactory: PDFCanvasFactory;
  destroy(): Promise<void>;
}

export interface PDFPageProxy {
  getTextContent(): Promise<PDFTextContent>;
  getViewport(params: { scale: number }): PDFPageViewport;
  render(params: { canvasContext: unknown; viewport: PDFPageViewport }): { promise: Promise<void> };
  cleanup(): boolean;
}

export interface PDFPageViewport {
  width: number;
  height: number;
}

/** A canvas from pdf.js's Node canvas factory (@napi-rs/canvas). */
export interface PDFCanvas {
  width: number;
  height: number;
  toBuffer(mimeType: 'image/png'): Buffer;
}

export interface PDFCanvasAndContext {
  canvas: PDFCanvas;
  context: unknown;
}

export interface PDFCanvasFactory {
  create(width: number, height: number): PDFCanvasAndContext;
  destroy(canvasAndContext: PDFCanvasAndContext): void;
}

export interface PDFTextContent {
  items: PDFTextItem[];
}

export interface PDFTextItem {
  str: string;
  /** pdf.js sets this on the item that ends a visual line. */
  hasEOL?: boolean;
  /** pdf.js text-item matrix; index 5 is the baseline Y in PDF units. */
  transform?: number[];
}

export interface PDFInfo {
  Title?: string;
  Author?: string;
  Subject?: string;
  Creator?: string;
  [key: string]: unknown;
}

export interface PDFLoadingTask {
  promise: Promise<PDFDocumentProxy>;
}
