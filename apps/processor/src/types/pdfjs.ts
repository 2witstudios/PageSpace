export interface PDFDocumentProxy {
  numPages: number;
  getPage(pageNum: number): Promise<PDFPageProxy>;
  getMetadata(): Promise<{ info: PDFInfo | null }>;
}

export interface PDFPageProxy {
  getTextContent(): Promise<PDFTextContent>;
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
