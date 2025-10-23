import { getPageSize } from "./utils";

export interface PageSize {
  pageHeight: number;
  pageWidth: number;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
}

// Pre-defined page sizes (all values in pixels at 96 DPI)
export const A4_PAGE_SIZE = getPageSize(1123, 794, 95, 95, 76, 76);
export const A3_PAGE_SIZE = getPageSize(1591, 1123, 95, 95, 76, 76);
export const A5_PAGE_SIZE = getPageSize(794, 419, 76, 76, 57, 57);
export const LETTER_PAGE_SIZE = getPageSize(1060, 818, 96, 96, 96, 96);
export const LEGAL_PAGE_SIZE = getPageSize(1404, 818, 96, 96, 96, 96);
export const TABLOID_PAGE_SIZE = getPageSize(1635, 1060, 96, 96, 96, 96);

export const PAGE_SIZES = {
  A4: A4_PAGE_SIZE,
  A3: A3_PAGE_SIZE,
  A5: A5_PAGE_SIZE,
  LETTER: LETTER_PAGE_SIZE,
  LEGAL: LEGAL_PAGE_SIZE,
  TABLOID: TABLOID_PAGE_SIZE,
};
