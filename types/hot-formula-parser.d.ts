declare module 'hot-formula-parser' {
  interface CellCoordinate {
    row: { index: number };
    column: { index: number };
    sheet?: string;
  }

  interface ParserResult {
    result: any;
    error: string | null;
  }

  type CellValueHandler = (cellCoord: CellCoordinate, done: (value: any) => void) => void;
  type RangeValueHandler = (
    start: CellCoordinate,
    end: CellCoordinate,
    done: (values: any[][]) => void
  ) => void;

  export class Parser {
    parse(formula: string): ParserResult;
    on(event: 'callCellValue', handler: CellValueHandler): void;
    on(event: 'callRangeValue', handler: RangeValueHandler): void;
  }
}
