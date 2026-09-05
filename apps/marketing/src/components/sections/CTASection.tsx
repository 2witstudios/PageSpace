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
          <Button size="lg" asChild>
            <a href={`${APP_URL}/auth/signup`}>
              Start free
              <ArrowRight className="ml-2 h-4 w-4" />
            </a>
          </Button>
          <Button size="lg" variant="outline" asChild>
            <Link href="/pricing">View pricing</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
