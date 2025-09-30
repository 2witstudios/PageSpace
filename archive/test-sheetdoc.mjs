import { createEmptySheet, serializeSheetContent } from '../packages/lib/src/sheet';

const sheet = createEmptySheet(5, 5);
sheet.cells.A1 = 'Revenue';
sheet.cells.B1 = '1000';
sheet.cells.C1 = '1500';
sheet.cells.A2 = 'Expenses';
sheet.cells.B2 = '600';
sheet.cells.C2 = '800';
sheet.cells.A3 = 'Profit';
sheet.cells.B3 = '=B1-B2';
sheet.cells.C3 = '=C1-C2';
sheet.cells.A4 = 'Total Profit';
sheet.cells.B4 = '=B3+C3';

console.log(serializeSheetContent(sheet));