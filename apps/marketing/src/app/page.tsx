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
import { TESTIMONIAL } from "@/components/sections/landing/testimonial-data";
import { pageMetadata } from "@/lib/metadata";
import { JsonLd, webApplicationSchema, createReviewSchema } from "@/lib/schema";
import "@/components/sections/landing/landing.css";

export const metadata = pageMetadata.home;

export default function Home() {
  const reviewSchema = createReviewSchema({
    author: TESTIMONIAL.author,
    body: TESTIMONIAL.body,
    url: TESTIMONIAL.url,
  });

  return (
    <div className="lp min-h-screen bg-background">
      <JsonLd data={[webApplicationSchema, reviewSchema]} />
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
