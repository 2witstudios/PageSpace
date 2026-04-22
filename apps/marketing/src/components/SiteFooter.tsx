import Link from "next/link";
import Image from "next/image";
import { Github } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";

const productLinks = [
  { label: "Pricing", href: "/pricing" },
  { label: "Downloads", href: "/downloads" },
  { label: "Blog", href: "/blog" },
  { label: "Security", href: "/security" },
];

const resourceLinks = [
  { label: "Documentation", href: "/docs" },
  { label: "Getting Started", href: "/docs/getting-started" },
  { label: "Page Types", href: "/docs/page-types" },
  { label: "Integrations", href: "/docs/integrations" },
];

const companyLinks = [
  { label: "FAQ", href: "/faq" },
  { label: "Contact", href: "/contact" },
  { label: "Privacy", href: "/privacy" },
  { label: "Terms", href: "/terms" },
];

function FooterLinkGroup({ title, links }: { title: string; links: { label: string; href: string }[] }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <ul className="mt-4 space-y-2.5">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="bg-muted/30">
      <div className="h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />
      <div className="container mx-auto px-4 md:px-6 py-16 md:py-20">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 md:gap-12">
          {/* Brand */}
          <div className="col-span-2 md:col-span-1">
            <Link href="/" className="flex items-center gap-2">
              <Image
                src="/android-chrome-192x192.png"
                alt="PageSpace"
                width={20}
                height={20}
                className="rounded"
              />
              <span className="font-semibold text-foreground">PageSpace</span>
            </Link>
            <p className="mt-3 text-sm text-muted-foreground max-w-[220px]">
              AI-powered workspace for docs, code, and collaboration.
            </p>
            <a
              href="https://github.com/2witstudios/PageSpace"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-block text-muted-foreground hover:text-foreground transition-colors"
              aria-label="PageSpace on GitHub"
            >
              <Github className="size-5" />
            </a>
          </div>

          {/* Product */}
          <FooterLinkGroup title="Product" links={productLinks} />

          {/* Resources */}
          <FooterLinkGroup title="Resources" links={resourceLinks} />

          {/* Company */}
          <div className="col-span-2 md:col-span-1">
            <FooterLinkGroup title="Company" links={companyLinks} />
          </div>
        </div>

        {/* Bottom bar */}
        <div className="mt-12 pt-8 border-t border-border flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            &copy; 2026 PageSpace. All rights reserved.
          </p>
          <ThemeToggle />
        </div>
      </div>
    </footer>
  );
}
