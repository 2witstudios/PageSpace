export interface HistoryEntry {
  command: string;
  output: string;
  timestamp: number;
}

export interface TerminalSession {
  history: HistoryEntry[];
}
