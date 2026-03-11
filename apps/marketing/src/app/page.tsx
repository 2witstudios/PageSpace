import { SiteNavbar } from "@/components/SiteNavbar";
import { SiteFooter } from "@/components/SiteFooter";
import {
  HeroSection,
  FeaturesPreviewSection,
  PageTreeSection,
  DocumentsSection,
  ChannelsSection,
  TasksSection,
  CalendarSection,
  CTASection,
} from "@/components/sections";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata.home;

export default function Home() {
  return (
    <div className="min-h-screen bg-background">
      <SiteNavbar />
      <HeroSection />
      <FeaturesPreviewSection />
      <PageTreeSection />
      <DocumentsSection />
      <ChannelsSection />
      <TasksSection />
      <CalendarSection />
      <CTASection />
      <SiteFooter />
    </div>
  );
}
