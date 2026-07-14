import type { PageDetails } from "../../lib/pagespace";

interface GenericMetaViewProps {
  details: PageDetails;
}

export function GenericMetaView({ details }: GenericMetaViewProps) {
  return (
    <div className="generic-meta-view">
      <p className="muted">
        {details.type} pages don't have a dedicated view in this demo yet — showing the raw page record instead.
      </p>
      <dl className="meta-grid">
        <dt>Id</dt>
        <dd>{details.id}</dd>
        <dt>Created</dt>
        <dd>{details.createdAt}</dd>
        <dt>Updated</dt>
        <dd>{details.updatedAt}</dd>
        <dt>Children</dt>
        <dd>{details.children.length}</dd>
      </dl>
    </div>
  );
}
