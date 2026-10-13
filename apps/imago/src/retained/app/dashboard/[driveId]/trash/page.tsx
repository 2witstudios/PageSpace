'use client';

import { useParams, useRouter, useSearchParams } from '@/retained-adapters/navigation';
import { TrashView } from '@/ui/tools/trash/trash-view';
import { trashFilterFrom } from '@/ui/tools/trash/trash-model';

/** The trash middle; the Files pane beside it is the shell's. */
export default function TrashPage() {
  const params = useParams();
  const driveId = params.driveId as string;
  const router = useRouter();
  const filter = trashFilterFrom(useSearchParams().get('type'));

  return <TrashView driveId={driveId} filter={filter} onFilterChange={(href) => router.replace(href)} />;
}
