# Editor Architecture

This document provides a comprehensive overview of the editor architecture in PageSpace. It explains our "HTML as Source of Truth" philosophy, the dual-editor system (Tiptap & Monaco), and how we support both human and AI editing workflows without data bloat.

## Table of Contents

1. [Core Philosophy: HTML as Source of Truth](#core-philosophy-html-as-source-of-truth)
2. [Dual-Editor System](#dual-editor-system)
3. [AI Compatibility: Line Breaks Without Bloat](#ai-compatibility-line-breaks-without-bloat)
4. [State Management](#state-management)
5. [Markdown Support](#markdown-support)
6. [Implementation Guide](#implementation-guide)

## Core Philosophy: HTML as Source of Truth

We handle document storage and synchronization with a strict **HTML-first approach**.

*   **HTML is the Database Format:** We store standard, semantic HTML. We do not store Tiptap JSON, ProseMirror schemas, or proprietary intermediate formats.
*   **No "Source" vs "Output":** What you see in the Code editor is exactly what is stored in the database and exactly what the AI reads.
*   **Lightweight & Portable:** By avoiding complex JSON trees or XML schemas, our documents remain portable, easily queryable, and immune to schema migration hell.

This constraint forces us to solve problems (like AI line-addressability) at the *runtime* level rather than the *storage* level, keeping our data clean.

## Dual-Editor System

Users can switch between two views of the same document content at any time. Both views are synchronized via a single state source.

### 1. Rich Text (Tiptap)
*   **Powered by:** [Tiptap](../2.5-integrations/tiptap.md) (Headless wrapper around ProseMirror)
*   **Role:** The primary WYSIWYG interface for human users.
*   **Mechanism:** Parses the HTML string into a ProseMirror node tree on initialization. Serializes the tree back to an HTML string on every change.

### 2. Code (Monaco)
*   **Powered by:** [Monaco Editor](../2.5-integrations/monaco-editor.md) (VS Code's core)
*   **Role:** Precision editing, raw HTML manipulation, and "truth" verification.
*   **Mechanism:** Displays the `content` string directly.

### Synchronization
When a user switches from Rich to Code (or vice-versa), we simply unmount one component and mount the other, initializing it with the current `content` string from our store. There is no complex transformation pipeline—just passing the string.

**Exception:** In `RichEditor.tsx`, we perform minimal normalization on code blocks (e.g., standardizing `<pre><code>` structures) to ensure Tiptap's parser doesn't swallow whitespace, but the core content remains untouched.

## AI Compatibility: Line Breaks Without Bloat

A major challenge in HTML-based storage is that minified or standard HTML often appears as a single long line or large blocks of text. AI models, which often rely on line-number addressing (e.g., "Replace lines 10-15"), fail catastrophically when presented with a 5000-character single-line string.

**Legacy Solution (Deprecated):** We used to run Prettier on the HTML before saving.
*   *Problem:* This bloated the database with whitespace and caused "fighting" between the editor's serializer and Prettier.

**Current Solution: `addLineBreaksForAI`**
We solve this with a runtime utility that creates a "virtual" line-based view for the AI without altering the stored data.

### How It Works
1.  **Storage:** Content is stored as clean, compact HTML (e.g., `<p>Hello</p><p>World</p>`).
2.  **AI Read:** When the AI requests to read a page, we run `addLineBreaksForAI`.
    *   This utility inserts newline characters (`\n`) *around* block-level elements (`<p>`, `div`, `h1`-`h6`, `ul`, `table`, etc.).
    *   It does **not** reformat the inner content.
3.  **AI Edit:** The AI sees a multi-line document and issues a `replace_lines` command.
4.  **Application:** We apply the line replacement to the temporary multi-line view, then save the result.

**Result:** The AI gets the "lines" it needs to be accurate, but our database and network payloads remain free of unnecessary formatting bloat.

## State Management

We use `zustand` to manage the document state globally, detached from the specific editor instance. This allows the state to persist even when switching editor views.

### The `useDocument` Hook
Located in `apps/web/src/hooks/useDocument.ts`, this hook serves as the controller for all document operations.

#### Key Behaviors
1.  **Immediate Updates:** Types in the editor trigger `updateContent()`, which updates the local store immediately for UI responsiveness.
2.  **Debounced Saving:** We use a **1000ms debounce** timer (`saveWithDebounce`) for auto-saving to the API.
3.  **Dirty State:** The `isDirty` flag tracks if local changes differ from the server state.
4.  **Conflict Detection:** If an update comes in from the socket (another user/AI) while `isDirty` is true, we skip the update to prevent overwriting the user's active work.

## Markdown Support

While HTML is our primary format, we fully support Markdown for users who prefer it.

*   **Mode Switch:** The `contentMode` state ('html' | 'markdown') determines how content is treated.
*   **Tiptap:** Uses `tiptap-markdown` to serialize/deserialize content as Markdown instead of HTML.
*   **Monaco:** Sets the editor language to `markdown` for proper syntax highlighting.
*   **AI Handling:** Since Markdown is naturally line-based, the AI tools detect `contentMode === 'markdown'` and **skip** the `addLineBreaksForAI` step, serving the raw Markdown directly.

## Implementation Guide

When working on editor features, follow these constraints:

1.  **Never rely on formatting for logic.** Don't assume HTML attributes will be in a specific order.
2.  **Test both modes.** Any feature added to Tiptap must resolve gracefully to HTML that is editable in Monaco.
3.  **Respect the debounce.** Do not force immediate saves unless absolutely necessary (e.g., unmount).
4.  **Keep it lightweight.** Avoid adding heavyweight extensions that inject massive JSON payloads into the HTML attributes.
