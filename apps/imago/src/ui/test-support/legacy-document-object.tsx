import { documentOf } from '../files/page-view/page-view';
import { DocumentView } from '../files/document-view/document-view';
import { usePage } from '../files/page-object/page-object';
import { renderObjectPlaceholder } from '../frame/shell/object-placeholder';
/** Keep the original standalone editor's regression suite targeted at that editor. */
export function LegacyDocumentObject({ driveId, pageId }: { driveId: string; pageId: string }) {
  const { data } = usePage(pageId);
  const page = documentOf(data);
  return page ? <DocumentView driveId={driveId} page={page} /> : renderObjectPlaceholder('Page');
}
