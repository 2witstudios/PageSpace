import { SiteNavbar } from "@/components/SiteNavbar";
import { SiteFooter } from "@/components/SiteFooter";
import { DocsSidebar } from "@/components/DocsSidebar";
import { DocsContent } from "@/components/DocsContent";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <SiteNavbar />
      <div className="container mx-auto px-4 md:px-6">
        <div className="flex gap-8 py-8">
          <DocsSidebar />
          <DocsContent>{children}</DocsContent>
        </div>
      </div>
      <SiteFooter />
    </div>
  );
}
