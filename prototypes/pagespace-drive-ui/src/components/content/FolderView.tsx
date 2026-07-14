import { iconForType, type PageRow } from "../../lib/pagespace";

interface FolderViewProps {
  children: PageRow[];
  onOpen: (page: PageRow) => void;
}

export function FolderView({ children, onOpen }: FolderViewProps) {
  if (children.length === 0) {
    return <p className="muted">This folder is empty.</p>;
  }

  return (
    <div className="folder-grid">
      {children.map((child) => (
        <button key={child.id} type="button" className="folder-card" onClick={() => onOpen(child)}>
          <span className="folder-card-icon">{iconForType(child.type)}</span>
          <span className="folder-card-title">{child.title ?? "Untitled"}</span>
          <span className="folder-card-type">{child.hasChildren ? `${child.type} · has children` : child.type}</span>
        </button>
      ))}
    </div>
  );
}
