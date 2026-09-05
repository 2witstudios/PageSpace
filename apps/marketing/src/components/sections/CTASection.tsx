import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { APP_URL } from "@/lib/metadata";

/** Final CTA — one primary action (Start free), repeated. */
export function CTASection() {
  return (
    <section className="cta">
      <div className="cta-in">
        <h2>Ready to put AI to work?</h2>
        <p>Start free and give your team an AI that does the actual work.</p>
        <div className="cta-actions">
          <a className="cta-primary" href={`${APP_URL}/auth/signup`}>
            Start free
            <span className="cta-arrow" aria-hidden="true">
              <ArrowRight />
            </span>
          </a>
          <Button
            size="lg"
            variant="outline"
            asChild
            className="h-[44px] rounded-[calc(var(--radius)+2px)] px-5 text-[15px]"
          >
            <Link href="/pricing">View pricing</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
