import Link from "next/link";
import {
  ArrowRight,
  Download,
  FileText,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { APP_URL } from "@/lib/metadata";

export function CTASection() {
  return (
    <section className="border-t border-border bg-gradient-to-b from-muted/50 to-background py-16 md:py-24 lg:py-32">
      <div className="container mx-auto px-4 md:px-6">
        <div className="mx-auto max-w-4xl text-center">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl mb-6">
            Ready to work differently?
          </h2>

          <p className="mx-auto max-w-2xl text-lg text-muted-foreground mb-10">
            Join teams who&apos;ve discovered that the best AI isn&apos;t a chatbot—it&apos;s a collaborator
            that lives in your workspace and understands your work.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-12">
            <Button size="lg" asChild className="w-full sm:w-auto">
              <a href={`${APP_URL}/auth/signup`}>
                Get Started Free
                <ArrowRight className="ml-2 h-4 w-4" />
              </a>
            </Button>
            <Button size="lg" variant="outline" asChild className="w-full sm:w-auto">
              <Link href="/pricing">View Pricing</Link>
            </Button>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-6 pt-8 border-t border-border">
            {[
              { icon: Download, label: "Desktop Apps", href: "/downloads" },
              { icon: FileText, label: "Documentation", href: "/docs" },
              { icon: Zap, label: "Blog", href: "/blog" },
            ].map((link) => (
              <Link key={link.label} href={link.href} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
                <link.icon className="h-4 w-4" />
                {link.label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
