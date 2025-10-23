import { PageSize } from "./constants";

export interface PaginationConfig {
  pageHeight: number;
  pageWidth: number;
  pageHeaderHeight: number;
  pageFooterHeight: number;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  contentMarginTop: number;
  contentMarginBottom: number;
  pageGapBorderColor: string;
}

/**
 * Updates CSS custom properties on the target node for pagination layout
 */
export const updateCssVariables = (targetNode: HTMLElement, config: PaginationConfig): void => {
  const headerFooterHeight =
    config.pageHeaderHeight + config.pageFooterHeight;
  const _pageContentHeight =
    config.pageHeight -
    headerFooterHeight -
    config.contentMarginTop -
    config.contentMarginBottom -
    config.marginTop -
    config.marginBottom;

  const cssVariables: Record<string, string> = {
    "rm-page-content-height": `${_pageContentHeight}px`,
    "rm-max-content-child-height": `${_pageContentHeight - 10}px`,
    "rm-margin-top": `${config.marginTop}px`,
    "rm-margin-bottom": `${config.marginBottom}px`,
    "rm-margin-left": `${config.marginLeft}px`,
    "rm-margin-right": `${config.marginRight}px`,
    "rm-content-margin-top": `${config.contentMarginTop}px`,
    "rm-content-margin-bottom": `${config.contentMarginBottom}px`,
    "rm-page-gap-border-color": `${config.pageGapBorderColor}`,
    "rm-page-width": `${config.pageWidth}px`,
  };

  Object.entries(cssVariables).forEach(([key, value]) => {
    targetNode.style.setProperty(`--${key}`, value);
  });
};

/**
 * Helper to create a PageSize object
 */
export const getPageSize = (
  height: number,
  width: number,
  marginTop: number,
  marginBottom: number,
  marginLeft: number,
  marginRight: number
): PageSize => {
  return {
    pageHeight: height,
    pageWidth: width,
    marginTop,
    marginBottom,
    marginLeft,
    marginRight,
  };
};
