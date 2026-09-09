import type { Node as PmNode } from 'prosemirror-model';
import type * as Y from 'yjs';
import { updateYFragment } from 'y-prosemirror';
import { collabFragment } from './collab-document.js';

/**
 * Replaces a live `Y.Doc`'s content with `nextDoc` as a **minimal CRDT diff**.
 *
 * This is how every server-computed document reaches a live document: an AI
 * edit, a version restore, a projection-driven repair. The obvious
 * implementation — clear the fragment and insert the new document — is
 * catastrophic here for two independent reasons, and the second is the one
 * that loses data:
 *
 * 1. **Size.** A CRDT update is a log, not a snapshot. Delete-all-and-reinsert
 *    emits an update proportional to the *document*, so a one-word AI
 *    correction to a long page costs every connected client a full re-download
 *    and grows the document's history by its own length, permanently.
 * 2. **Concurrency.** Every character of the old document is tombstoned and
 *    every character of the new one is a fresh insertion, so a collaborator's
 *    concurrent edit in an untouched paragraph merges against nothing and
 *    disappears. Not a conflict — a silent loss.
 *
 * `updateYFragment` is `y-prosemirror`'s own structural diff, the same one
 * `ySyncPlugin` runs on every local transaction, so this path is exactly as
 * well-tested as ordinary typing.
 *
 * The `meta` it takes is a fresh, empty pair of maps — deliberately, and this
 * was corrected by mutation testing after the first version called
 * `initProseMirrorDoc` to build a populated mapping first. That looked
 * necessary (`updateYFragment` consults `meta.mapping` through
 * `mappedIdentity`) and is not: on a mapping miss it falls back to
 * `equalYTypePNode`, a deep structural comparison, so the diff is minimal
 * either way — measured, 41 bytes with a populated mapping and 41 bytes
 * without, on a 37 KB document. `initProseMirrorDoc` materialises the entire
 * fragment as ProseMirror nodes to build that mapping, so keeping it would
 * have cost an O(document) walk on every apply for no effect. `y-prosemirror`
 * itself passes `{ mapping: new Map(), isOMark: new Map() }` for exactly this
 * kind of one-shot conversion (`sync-plugin.js:564`), and `isOMark` is a
 * lazily-populated memo, so empty is not merely tolerable but correct.
 *
 * What IS load-bearing is `updateYFragment` itself rather than
 * delete-and-reinsert, and the tests that guard it assert an update *size* and
 * Y-type *identity* — the only observable differences between a correct diff
 * and a correct-looking one.
 *
 * `origin` is forwarded to `Y.Doc.transact` so a caller (the collab service)
 * can recognise its own writes in an `update` handler and avoid echoing them
 * back to the client that caused them.
 */
export function applyPmDocToYDoc(yDoc: Y.Doc, nextDoc: PmNode, origin?: unknown): void {
  const fragment = collabFragment(yDoc);
  yDoc.transact(() => {
    updateYFragment(yDoc, fragment, nextDoc, { mapping: new Map(), isOMark: new Map() });
  }, origin);
}
