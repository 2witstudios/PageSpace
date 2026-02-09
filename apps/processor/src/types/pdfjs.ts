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
