import { FileText, Bot, MessageSquare, CheckSquare, Calendar } from "lucide-react";

const features = [
  { icon: FileText, label: "Documents", desc: "AI-assisted editing" },
  { icon: Bot, label: "Agents", desc: "AI that takes action" },
  { icon: MessageSquare, label: "Channels", desc: "Team + AI messaging" },
  { icon: CheckSquare, label: "Tasks", desc: "Assign to AI or humans" },
  { icon: Calendar, label: "Calendar", desc: "Unified view" },
];

export function FeaturesPreviewSection() {
  return (
    <section className="border-t border-border bg-muted/30 py-16 md:py-24">
      <div className="container mx-auto px-4 md:px-6">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-8">
          {features.map((feature) => (
            <div key={feature.label} className="text-center">
              <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 mb-4">
                <feature.icon className="h-6 w-6 text-primary" />
              </div>
              <h3 className="font-semibold mb-1">{feature.label}</h3>
              <p className="text-sm text-muted-foreground">{feature.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
