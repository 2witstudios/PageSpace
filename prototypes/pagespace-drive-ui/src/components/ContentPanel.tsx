import { useEffect, useState } from "react";
import type { PageSpaceClient } from "@pagespace/sdk";
import {
  describeError,
  iconForType,
  parseChannelTranscript,
  TEXT_EDITABLE_TYPES,
  toChatMessage,
  type ChatMessage,
  type FileReadResult,
  type PageDetails,
  type PageListResult,
  type PageRow,
  type TaskListReadResult,
} from "../lib/pagespace";
import { Breadcrumb } from "./Breadcrumb";
import { FolderView } from "./content/FolderView";
import { TextView } from "./content/TextView";
import { TaskListView } from "./content/TaskListView";
import { ChannelView } from "./content/ChannelView";
import { FileView } from "./content/FileView";
import { GenericMetaView } from "./content/GenericMetaView";

interface ContentPanelProps {
  client: PageSpaceClient;
  driveId: string;
  driveName: string;
  page: PageRow | null;
  onOpenPage: (page: PageRow) => void;
  onNavigateBreadcrumb: (id: string | null) => void;
  onRenamed: (title: string) => void;
  onMoveRequest: (page: PageRow) => void;
  onTrashed: () => void;
}

interface GenericTextData {
  content: string;
  totalLines: number;
}

export function ContentPanel({
  client,
  driveId,
  driveName,
  page,
  onOpenPage,
  onNavigateBreadcrumb,
  onRenamed,
  onMoveRequest,
  onTrashed,
}: ContentPanelProps) {
  const [location, setLocation] = useState<PageListResult | null>(null);
  const [details, setDetails] = useState<PageDetails | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [textData, setTextData] = useState<GenericTextData | null>(null);
  const [taskData, setTaskData] = useState<TaskListReadResult | null>(null);
  const [fileData, setFileData] = useState<FileReadResult | null>(null);

  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setLocation(null);
    setDetails(null);
    setMessages([]);
    setTextData(null);
    setTaskData(null);
    setFileData(null);
    setEditing(false);
    setSaveMessage(null);
    setError(null);
    setRenaming(false);
    if (!page) return;

    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [loc, det] = await Promise.all([
          client.pages.list({ driveId, parentId: page.id, ls: true }),
          client.pages.details({ pageId: page.id }),
        ]);
        if (cancelled) return;
        setLocation(loc);
        setDetails(det);
        setMessages(det.messages.map(toChatMessage));

        if (TEXT_EDITABLE_TYPES.includes(page.type)) {
          const r = (await client.pages.read({ operation: "read", pageId: page.id })) as unknown as GenericTextData;
          if (cancelled) return;
          setTextData(r);
          setDraft(r.content);
        } else if (page.type === "TASK_LIST") {
          const r = (await client.pages.read({ operation: "read", pageId: page.id })) as unknown as TaskListReadResult;
          if (cancelled) return;
          setTaskData(r);
        } else if (page.type === "FILE") {
          const r = (await client.pages.read({ operation: "read", pageId: page.id })) as unknown as FileReadResult;
          if (cancelled) return;
          setFileData(r);
        } else if (page.type === "CHANNEL") {
          // pages.details' messages array isn't populated for CHANNEL pages
          // (confirmed against a live drive) — pages.read's flattened
          // transcript is the only source of history. See parseChannelTranscript.
          const r = (await client.pages.read({ operation: "read", pageId: page.id })) as unknown as { numberedLines: string[] };
          if (cancelled) return;
          setMessages(parseChannelTranscript(r.numberedLines));
        }
      } catch (e) {
        if (!cancelled) setError(describeError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, driveId, page]);

  const save = async () => {
    if (!page || !textData) return;
    setSaving(true);
    setSaveMessage(null);
    setError(null);
    try {
      const result = await client.pages.replaceLines({
        operation: "replace",
        pageId: page.id,
        startLine: 1,
        endLine: textData.totalLines,
        content: draft,
      });
      setSaveMessage(`Saved — ${result.totalLines} line(s) now.`);
      setTextData({ totalLines: result.totalLines, content: draft });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSaving(false);
    }
  };

  const changeTaskStatus = async (taskId: string, status: string) => {
    if (!page) return;
    try {
      await client.tasks.update({ pageId: page.id, taskId, status });
      setTaskData((prev) =>
        prev ? { ...prev, tasks: prev.tasks.map((t) => (t.id === taskId ? { ...t, status } : t)) } : prev,
      );
    } catch (e) {
      setError(describeError(e));
    }
  };

  const sendMessage = async (content: string) => {
    if (!page) return;
    setSending(true);
    setError(null);
    try {
      const message = await client.channels.send({ pageId: page.id, content });
      setMessages((prev) => [
        ...prev,
        { id: message.id, content: message.content, createdAt: message.createdAt, user: { name: message.user.name } },
      ]);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSending(false);
    }
  };

  const startRename = () => {
    if (!page) return;
    setRenameValue(page.title ?? "");
    setRenaming(true);
  };

  const submitRename = async () => {
    if (!page || !renameValue.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await client.pages.rename({ pageId: page.id, title: renameValue.trim() });
      onRenamed(renameValue.trim());
      setRenaming(false);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const submitTrash = async () => {
    if (!page) return;
    const confirmMessage = page.hasChildren
      ? `Trash "${page.title ?? "Untitled"}" and all of its children?`
      : `Trash "${page.title ?? "Untitled"}"?`;
    if (!window.confirm(confirmMessage)) return;
    setBusy(true);
    setError(null);
    try {
      await client.pages.trash({ pageId: page.id, trash_children: true });
      onTrashed();
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  };

  if (!page) {
    return (
      <section className="content-panel content-panel-empty">
        <p className="muted">Select a page from the sidebar to view it here.</p>
      </section>
    );
  }

  const crumbs = [...(location?.breadcrumb ?? []), { id: page.id, title: page.title ?? "Untitled" }];
  const dedupedCrumbs = crumbs.filter((c, i) => i === 0 || c.id !== crumbs[i - 1].id);

  return (
    <section className="content-panel">
      <Breadcrumb driveName={driveName} crumbs={dedupedCrumbs} onNavigate={onNavigateBreadcrumb} />

      <div className="content-header">
        <span className="content-icon">{iconForType(page.type)}</span>
        {!renaming ? (
          <h2>{page.title ?? "Untitled"}</h2>
        ) : (
          <input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setRenaming(false);
              }
            }}
          />
        )}
        <span className="tree-type-badge">{page.type}</span>

        <div className="content-actions">
          {!renaming ? (
            <button type="button" onClick={startRename} disabled={busy}>
              Rename
            </button>
          ) : (
            <>
              <button type="button" onClick={submitRename} disabled={busy || !renameValue.trim()}>
                Save
              </button>
              <button type="button" onClick={() => setRenaming(false)} disabled={busy}>
                Cancel
              </button>
            </>
          )}
          <button type="button" onClick={() => onMoveRequest(page)} disabled={busy}>
            Move
          </button>
          <button type="button" className="danger" onClick={submitTrash} disabled={busy}>
            Trash
          </button>
        </div>
      </div>

      {loading && <p className="muted">Loading…</p>}
      {error && <p className="error-text">{error}</p>}

      {!loading && (
        <>
          {page.type === "FOLDER" && location && <FolderView children={location.pages} onOpen={onOpenPage} />}

          {TEXT_EDITABLE_TYPES.includes(page.type) && textData && (
            <TextView
              content={textData.content}
              draft={draft}
              onDraftChange={setDraft}
              editing={editing}
              onEditingChange={setEditing}
              saving={saving}
              saveMessage={saveMessage}
              onSave={save}
              monospace={page.type === "CODE"}
            />
          )}

          {page.type === "TASK_LIST" && taskData && (
            <TaskListView
              tasks={taskData.tasks}
              availableStatuses={taskData.availableStatuses}
              progress={taskData.progress}
              onStatusChange={changeTaskStatus}
            />
          )}

          {(page.type === "CHANNEL" || page.type === "AI_CHAT") && (
            <ChannelView messages={messages} canSend={page.type === "CHANNEL"} sending={sending} onSend={sendMessage} />
          )}

          {page.type === "FILE" && fileData && <FileView file={fileData} />}

          {(page.type === "SHEET" || page.type === "TERMINAL") && details && <GenericMetaView details={details} />}
        </>
      )}
    </section>
  );
}
