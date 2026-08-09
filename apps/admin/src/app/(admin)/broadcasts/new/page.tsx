import { PageHeader } from "@/components/admin/kit";
import { BroadcastComposer } from "@/components/admin/broadcasts/broadcast-composer";

export default function NewBroadcastPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="New broadcast"
        description="Compose or pick a template, target an audience, preview, then send."
      />
      <BroadcastComposer />
    </div>
  );
}
