import { Mail, MessageSquare } from "lucide-react";
import { SiteNavbar } from "@/components/SiteNavbar";
import { SiteFooter } from "@/components/SiteFooter";
import ContactForm from "@/components/ContactForm";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata.contact;

export default function ContactPage() {
  return (
    <div className="min-h-screen bg-background">
      <SiteNavbar />

      <section className="py-16 md:py-24">
        <div className="container mx-auto px-4 md:px-6">
          <div className="mx-auto max-w-3xl">
            {/* Header */}
            <div className="text-center mb-12">
              <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-muted/50 px-4 py-1.5 text-sm">
                <Mail className="h-4 w-4 text-primary" />
                <span className="text-muted-foreground">Contact Us</span>
              </div>
              <h1 className="text-4xl font-bold tracking-tight sm:text-5xl mb-4">
                Get in touch
              </h1>
              <p className="text-lg text-muted-foreground">
                Have a question, feedback, or want to learn more about PageSpace?
                We'd love to hear from you.
              </p>
            </div>

            {/* Contact Form */}
            <ContactForm />

            {/* Alternative Contact Methods */}
            <div className="mt-12 grid sm:grid-cols-2 gap-6">
              <div className="rounded-xl border border-border bg-card p-6 text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 mx-auto mb-3">
                  <Mail className="h-5 w-5 text-primary" />
                </div>
                <h3 className="font-semibold mb-1">Email</h3>
                <a
                  href="mailto:hello@pagespace.ai"
                  className="text-sm text-muted-foreground hover:text-primary transition-colors"
                >
                  hello@pagespace.ai
                </a>
              </div>
              <div className="rounded-xl border border-border bg-card p-6 text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 mx-auto mb-3">
                  <MessageSquare className="h-5 w-5 text-primary" />
                </div>
                <h3 className="font-semibold mb-1">Community</h3>
                <a
                  href="https://discord.gg/kve8qgzZ8x"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-muted-foreground hover:text-primary transition-colors"
                >
                  Join our Discord
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
