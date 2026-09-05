import { SiteNavbar } from "@/components/SiteNavbar";
import { SiteFooter } from "@/components/SiteFooter";
import {
  HeroSection,
  TestimonialSection,
  PageTypeCarouselSection,
  AskAutomateSection,
  SkillsSection,
  TrustSection,
  CTASection,
} from "@/components/sections";
import { TESTIMONIALS } from "@/components/sections/landing/testimonial-data";
import { pageMetadata } from "@/lib/metadata";
import { JsonLd, webApplicationSchema, createReviewSchema } from "@/lib/schema";
import "@/components/sections/landing/landing.css";

export const metadata = pageMetadata.home;

export default function Home() {
  const reviewSchemas = TESTIMONIALS.map((t) =>
    createReviewSchema({ author: t.author, body: t.body, url: t.url }),
  );

  return (
    <div className="lp min-h-screen bg-background">
      <JsonLd data={[webApplicationSchema, ...reviewSchemas]} />
      <SiteNavbar />
      <HeroSection />
      <TestimonialSection />
      <PageTypeCarouselSection />
      <AskAutomateSection />
      <SkillsSection />
      <TrustSection />
      <CTASection />
      <SiteFooter />
    </div>
  );
}
