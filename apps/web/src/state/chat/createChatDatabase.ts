import { Database, createUndoRedoService, type UndoRedoService } from '@adobe/data/ecs';
import { chatStatePlugin, type ChatStateDatabase } from './chat-state-plugin';

export interface ChatDatabaseHandle {
  readonly db: ChatStateDatabase;
  readonly undoRedo: UndoRedoService;
}

/**
 * SPIKE (@adobe/data adoption evidence). Builds one chat Database plus its
 * undo/redo service.
 *
 * A factory (not a module singleton) because tests need an isolated container
 * per case and the React harness needs one instance per provider. The
 * production facades below hold a lazily-created module singleton, which is the
 * shape that lets the existing zustand-consumer components stay unchanged.
 */
export const createChatDatabase = (): ChatDatabaseHandle => {
  const db = Database.create(chatStatePlugin);
  return { db, undoRedo: createUndoRedoService(db) };
};
