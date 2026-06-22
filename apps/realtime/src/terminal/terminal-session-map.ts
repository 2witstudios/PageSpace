export type TerminalSession = {
  command: {
    write(data: string): void;
    kill(signal?: string): void;
    resize(cols: number, rows: number): void;
  };
  sandboxId: string;
  reAuthInterval?: ReturnType<typeof setInterval>;
  releaseSlot(): void;
};

export type TerminalSessionMap = {
  get(id: string): TerminalSession | undefined;
  set(id: string, session: TerminalSession): void;
  delete(id: string): void;
  has(id: string): boolean;
};

export function createTerminalSessionMap(): TerminalSessionMap {
  const store = new Map<string, TerminalSession>();
  return {
    get: (id) => store.get(id),
    set: (id, session) => { store.set(id, session); },
    delete: (id) => { store.delete(id); },
    has: (id) => store.has(id),
  };
}
