/** The toolbar's count: "3 selected". */
export const selectedCountLabel = (count: number): string => `${count} selected`;

/** The trash confirm's body, naming what moves with the pages. */
export const trashConfirmBody = (count: number): string =>
  `This will move ${count} ${count === 1 ? 'page' : 'pages'} and all their children to the trash. You can restore them later.`;

/** The toast after a bulk trash. */
export const trashedToast = (count: number): string => `Successfully moved ${count} pages to trash`;
