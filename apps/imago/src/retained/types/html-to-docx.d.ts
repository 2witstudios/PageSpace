declare module 'html-to-docx' {
  interface Options {
    table?: {
      row?: {
        cantSplit?: boolean;
      };
    };
    footer?: boolean;
    pageNumber?: boolean;
    title?: string;
  }

  function HTMLtoDOCX(
    html: string,
    headerHTML?: string | null,
    options?: Options,
    vfsMerge?: unknown
  ): Promise<Buffer>;

  export default HTMLtoDOCX;
}
