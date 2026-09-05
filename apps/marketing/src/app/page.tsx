import { SiteNavbar } from "@/components/SiteNavbar";
import { SiteFooter } from "@/components/SiteFooter";
import {
  HeroSection,
  TestimonialSection,
  PageTypeCarouselSection,
  AskAutomateSection,
  SkillsSection,
  TrustSection,
  FaqSection,
  CTASection,
} from "@/components/sections";
import { FAQ_ITEMS } from "@/components/sections/landing/faq-data";
import { TESTIMONIAL } from "@/components/sections/landing/testimonial-data";
import { pageMetadata } from "@/lib/metadata";
import {
  JsonLd,
  webApplicationSchema,
  createFaqSchema,
  createReviewSchema,
} from "@/lib/schema";
import "@/components/sections/landing/landing.css";

export const metadata = pageMetadata.home;

export default function Home() {
  const faqSchema = createFaqSchema(FAQ_ITEMS.map((f) => ({ q: f.q, a: f.a })));
  const reviewSchema = createReviewSchema({
    author: TESTIMONIAL.author,
    body: TESTIMONIAL.body,
    url: TESTIMONIAL.url,
  });

  return (
    <div className="lp min-h-screen bg-background">
      <JsonLd data={[webApplicationSchema, faqSchema, reviewSchema]} />
      <SiteNavbar />
      <HeroSection />
      <TestimonialSection />
      <PageTypeCarouselSection />
      <AskAutomateSection />
      <SkillsSection />
      <TrustSection />
      <FaqSection />
      <CTASection />
      <SiteFooter />
    </div>
  );
}
