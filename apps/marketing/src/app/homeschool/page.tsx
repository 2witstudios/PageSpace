import { SiteNavbar } from "@/components/SiteNavbar";
import { SiteFooter } from "@/components/SiteFooter";
import {
  HomeschoolHeroSection,
  HomeschoolUseCasesSection,
  HomeschoolProgressSection,
  HomeschoolAITutorSection,
  HomeschoolFAQSection,
  HomeschoolCTASection,
} from "@/components/sections/HomeschoolSections";
import { createMetadata } from "@/lib/metadata";

export const metadata = createMetadata({
  title: "PageSpace for Homeschoolers — AI-Powered Curriculum Workspace",
  description:
    "Plan lessons, track each child's progress, and get AI help finding resources — all in one workspace built for homeschool families. Free to start.",
  path: "/homeschool",
  keywords: [
    "homeschool",
    "homeschooling",
    "curriculum planning",
    "lesson planning",
    "AI tutor",
    "homeschool tracker",
    "homeschool app",
    "homeschool planner",
  ],
});

export default function HomeschoolPage() {
  return (
    <div className="min-h-screen bg-background">
      <SiteNavbar />
      <HomeschoolHeroSection />
      <HomeschoolUseCasesSection />
      <HomeschoolProgressSection />
      <HomeschoolAITutorSection />
      <HomeschoolFAQSection />
      <HomeschoolCTASection />
      <SiteFooter />
    </div>
  );
}
