import { SiteNavbar } from "@/components/SiteNavbar";
import { SiteFooter } from "@/components/SiteFooter";
import { LegalTodo } from "@/components/LegalTodo";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { pageMetadata, LEGAL_LAST_UPDATED } from "@/lib/metadata";

export const metadata = pageMetadata.subprocessors;

interface SubprocessorRow {
  vendor: string;
  purpose: string;
  dataCategories: string;
  location: string;
  transferMechanism: string;
  dpaStatus: string;
}

const subprocessors: SubprocessorRow[] = [
  {
    vendor: "Stripe, Inc.",
    purpose: "Payment processing and subscription billing",
    dataCategories: "Name, email, payment method, billing address, subscription/plan metadata",
    location: "United States",
    transferMechanism: "Standard Contractual Clauses (SCCs)",
    dpaStatus: "TODO",
  },
  {
    vendor: "Google LLC",
    purpose: "“Sign in with Google”; optional Google Calendar and Drive integration",
    dataCategories: "Email, profile name, OAuth tokens (encrypted at rest), connected calendar/file metadata",
    location: "United States",
    transferMechanism: "Standard Contractual Clauses (SCCs)",
    dpaStatus: "TODO",
  },
  {
    vendor: "GitHub, Inc.",
    purpose: "OAuth sign-in and optional repository integration",
    dataCategories: "Email, profile name, OAuth tokens (encrypted at rest), connected repository metadata",
    location: "United States",
    transferMechanism: "Standard Contractual Clauses (SCCs)",
    dpaStatus: "TODO",
  },
  {
    vendor: "Apple Inc. (APNs)",
    purpose: "Push notifications to the iOS app",
    dataCategories: "Device push token, notification payload",
    location: "United States",
    transferMechanism: "Standard Contractual Clauses (SCCs)",
    dpaStatus: "TODO",
  },
  {
    vendor: "Let's Encrypt (ISRG)",
    purpose: "TLS certificate issuance for custom domains",
    dataCategories: "Domain name and certificate validation records — no end-user personal data",
    location: "United States",
    transferMechanism: "Not applicable — no personal data processed",
    dpaStatus: "TODO",
  },
  {
    vendor: "DNS provider(s)",
    purpose: "DNS resolution for pagespace.ai and customer custom domains",
    dataCategories: "Domain names and DNS records — no end-user personal data",
    location: "TODO",
    transferMechanism: "TODO",
    dpaStatus: "TODO",
  },
  {
    vendor: "Control-plane host",
    purpose: "Hosts tenant provisioning, billing orchestration, and lifecycle management",
    dataCategories: "Tenant owner email, Stripe customer IDs, tenant metadata",
    location: "TODO",
    transferMechanism: "TODO",
    dpaStatus: "TODO",
  },
];

export default function Subprocessors() {
  return (
    <div className="min-h-screen bg-background">
      <SiteNavbar />

      <div className="container mx-auto px-4 py-12 md:py-16 max-w-4xl">
        <div className="mb-8">
          <h1 className="text-4xl font-bold mb-2">Subprocessors</h1>
          <p className="text-muted-foreground">Last updated: {LEGAL_LAST_UPDATED}</p>
        </div>

        <div className="prose prose-lg max-w-none dark:prose-invert">
          <section className="mb-8">
            <p className="mb-4">
              PageSpace uses a small number of third-party service providers (&quot;subprocessors&quot;) to
              deliver the product. This page lists each subprocessor, what it does for us, what
              categories of data it processes, where it&#39;s located, and the mechanism we rely on for
              any international transfer of personal data. See our{" "}
              <a href="/privacy" className="text-primary hover:underline">Privacy Policy</a> for how
              this fits into our overall data-processing practices.
            </p>
            <p className="mb-4">
              Note: our control-plane host stores tenant owner email addresses and Stripe customer
              IDs as part of provisioning and billing tenant workspaces — this is disclosed
              explicitly in the table below.
            </p>
          </section>

          <section className="mb-8">
            <div className="not-prose overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Vendor</TableHead>
                    <TableHead>Purpose</TableHead>
                    <TableHead>Data categories</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Transfer mechanism</TableHead>
                    <TableHead>DPA status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {subprocessors.map((row) => (
                    <TableRow key={row.vendor}>
                      <TableCell className="font-medium whitespace-normal">{row.vendor}</TableCell>
                      <TableCell className="whitespace-normal">{row.purpose}</TableCell>
                      <TableCell className="whitespace-normal">{row.dataCategories}</TableCell>
                      <TableCell className="whitespace-normal">
                        {row.location === "TODO" ? (
                          <span className="text-amber-600 dark:text-amber-400 font-medium">[TODO]</span>
                        ) : (
                          row.location
                        )}
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        {row.transferMechanism === "TODO" ? (
                          <span className="text-amber-600 dark:text-amber-400 font-medium">[TODO]</span>
                        ) : (
                          row.transferMechanism
                        )}
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        <span className="text-amber-600 dark:text-amber-400 font-medium">[TODO: confirm]</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <LegalTodo>
              Full DPA sign-off status per vendor, plus the DNS provider name and control-plane
              hosting provider, are tracked internally in
              <code className="mx-1">docs/security/gdpr-dpa-inventory.md</code>
              and need legal/ops confirmation before this table can be marked complete.
            </LegalTodo>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">AI model providers</h2>
            <p className="mb-4">
              AI model providers (Anthropic, OpenAI, Google, xAI, and OpenRouter as a routing
              provider) receive your prompts and relevant context on a per-request basis to generate
              responses — see the Third-Party AI Services section of our{" "}
              <a href="/privacy" className="text-primary hover:underline">Privacy Policy</a> for
              details. PageSpace also supports Ollama as a fully on-premises/local model option that
              does not send data to any third party.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">Changes to this list</h2>
            <p className="mb-4">
              We will post material changes to our subprocessor list on this page, along with an
              updated &quot;Last updated&quot; date, before or as those changes take effect.
            </p>
          </section>
        </div>
      </div>

      <SiteFooter />
    </div>
  );
}
