import { SiteNavbar } from "@/components/SiteNavbar";
import { SiteFooter } from "@/components/SiteFooter";
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
  dpa: { label: string; href: string };
}

const SCC_MODULE_2 = "EU SCCs (Module 2) + UK Addendum, incorporated in the vendor's DPA";

const infrastructure: SubprocessorRow[] = [
  {
    vendor: "Fly.io, Inc.",
    purpose:
      "Hosting for the application, database, real-time, file-processing, and control-plane services; sandboxed compute for agent sessions",
    dataCategories: "All account and content data (the primary database and application servers run here)",
    location: "United States (Ashburn, Virginia)",
    transferMechanism: `${SCC_MODULE_2}; Fly.io also adheres to the EU-U.S. Data Privacy Framework principles`,
    dpa: { label: "Fly.io Terms of Service (GDPR DPA provided pre-signed by Fly.io)", href: "https://fly.io/legal/terms-of-service/" },
  },
  {
    vendor: "Tigris Data, Inc.",
    purpose: "Object storage for uploaded files and encrypted database backups",
    dataCategories: "Uploaded files and attachments; AES-256-encrypted database backups",
    location: "United States",
    transferMechanism: SCC_MODULE_2,
    dpa: { label: "Tigris Data Processing Addendum", href: "https://www.tigrisdata.com/docs/legal/data-processing/" },
  },
  {
    vendor: "Namecheap, Inc.",
    purpose: "Domain registration and DNS for pagespace.ai",
    dataCategories: "Domain names and DNS records — no end-user personal data",
    location: "United States",
    transferMechanism: "Not applicable — no personal data processed",
    dpa: { label: "Namecheap Data Processing Addendum", href: "https://www.namecheap.com/legal/universal/data-processing-addendum/" },
  },
  {
    vendor: "Let's Encrypt (ISRG)",
    purpose: "TLS certificate issuance for pagespace.ai and customer custom domains",
    dataCategories: "Domain name and certificate validation records — no end-user personal data",
    location: "United States",
    transferMechanism: "Not applicable — no personal data processed",
    dpa: { label: "Let's Encrypt Subscriber Agreement", href: "https://letsencrypt.org/repository/" },
  },
];

const operations: SubprocessorRow[] = [
  {
    vendor: "Stripe, Inc.",
    purpose: "Payment processing and subscription billing",
    dataCategories: "Name, email, payment method, billing address, subscription/plan metadata",
    location: "United States",
    transferMechanism: SCC_MODULE_2,
    dpa: { label: "Stripe Data Processing Agreement", href: "https://stripe.com/legal/dpa" },
  },
  {
    vendor: "Resend, Inc.",
    purpose: "Transactional email (magic links, notifications) and opted-in product emails",
    dataCategories: "Email address, name, email content, delivery and unsubscribe status",
    location: "United States",
    transferMechanism: SCC_MODULE_2,
    dpa: { label: "Resend Data Processing Agreement", href: "https://resend.com/legal/dpa" },
  },
  {
    vendor: "Functional Software, Inc. (Sentry)",
    purpose: "Error and crash reporting",
    dataCategories: "Error stack traces, request metadata, and the user ID associated with an error. Personally identifying request data (sendDefaultPii) is disabled",
    location: "United States",
    transferMechanism: SCC_MODULE_2,
    dpa: { label: "Sentry Data Processing Addendum", href: "https://sentry.io/legal/dpa/" },
  },
  {
    vendor: "Apple Inc. (APNs)",
    purpose: "Push notifications to the iOS app",
    dataCategories: "Device push token, notification payload",
    location: "United States",
    transferMechanism: SCC_MODULE_2,
    dpa: { label: "Apple Developer Program License Agreement", href: "https://developer.apple.com/support/terms/" },
  },
  {
    vendor: "Google LLC (Firebase Cloud Messaging)",
    purpose: "Push notifications to the Android app",
    dataCategories: "Device registration token, notification payload",
    location: "United States",
    transferMechanism: SCC_MODULE_2,
    dpa: { label: "Firebase Data Processing and Security Terms", href: "https://firebase.google.com/terms/data-processing-terms" },
  },
];

const aiProviders: SubprocessorRow[] = [
  {
    vendor: "Anthropic, PBC",
    purpose: "AI model inference (Claude)",
    dataCategories: "Prompts and the workspace context you include in an AI request",
    location: "United States",
    transferMechanism: SCC_MODULE_2,
    dpa: { label: "Anthropic Data Processing Addendum", href: "https://www.anthropic.com/legal/data-processing-addendum" },
  },
  {
    vendor: "OpenAI, L.L.C.",
    purpose: "AI model inference (GPT)",
    dataCategories: "Prompts and the workspace context you include in an AI request",
    location: "United States",
    transferMechanism: SCC_MODULE_2,
    dpa: { label: "OpenAI Data Processing Addendum", href: "https://openai.com/policies/data-processing-addendum" },
  },
  {
    vendor: "Google LLC (Gemini API)",
    purpose: "AI model inference (Gemini)",
    dataCategories: "Prompts and the workspace context you include in an AI request",
    location: "United States",
    transferMechanism: SCC_MODULE_2,
    dpa: { label: "Google Cloud Data Processing Addendum", href: "https://cloud.google.com/terms/data-processing-addendum" },
  },
  {
    vendor: "xAI Corp.",
    purpose: "AI model inference (Grok)",
    dataCategories: "Prompts and the workspace context you include in an AI request",
    location: "United States",
    transferMechanism: SCC_MODULE_2,
    dpa: { label: "xAI Data Processing Addendum", href: "https://x.ai/legal/data-processing-addendum" },
  },
  {
    vendor: "OpenRouter, Inc.",
    purpose: "Routing to additional third-party models on paid plans, only when you select one of those models",
    dataCategories: "Prompts and the workspace context you include in an AI request; forwarded to the upstream model provider you selected",
    location: "United States (upstream providers vary by model)",
    transferMechanism: "OpenRouter Terms of Service and per-provider data-retention policies published by OpenRouter",
    dpa: { label: "OpenRouter Terms of Service", href: "https://openrouter.ai/terms" },
  },
];

const independentControllers: SubprocessorRow[] = [
  {
    vendor: "Google LLC (Sign in with Google, Calendar, Drive)",
    purpose: "Optional “Sign in with Google” and Google Calendar / Drive integrations",
    dataCategories: "Email, profile name, OAuth tokens (encrypted at rest), and the calendar/file data you choose to connect",
    location: "United States",
    transferMechanism: "You authorize Google directly; Google processes your Google account data as an independent controller under its own privacy policy",
    dpa: { label: "Google API Services User Data Policy", href: "https://developers.google.com/terms/api-services-user-data-policy" },
  },
  {
    vendor: "GitHub, Inc.",
    purpose: "Optional GitHub sign-in and repository integration",
    dataCategories: "Email, profile name, OAuth tokens (encrypted at rest), and the repository data you choose to connect",
    location: "United States",
    transferMechanism: "You authorize GitHub directly; GitHub processes your GitHub account data as an independent controller under its own privacy statement",
    dpa: { label: "GitHub Data Protection Agreement", href: "https://github.com/customer-terms/github-data-protection-agreement" },
  },
];

function SubprocessorTable({ rows }: { rows: SubprocessorRow[] }) {
  return (
    <div className="not-prose overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Vendor</TableHead>
            <TableHead>Purpose</TableHead>
            <TableHead>Data categories</TableHead>
            <TableHead>Location</TableHead>
            <TableHead>Transfer mechanism</TableHead>
            <TableHead>Data processing terms</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.vendor}>
              <TableCell className="font-medium whitespace-normal">{row.vendor}</TableCell>
              <TableCell className="whitespace-normal">{row.purpose}</TableCell>
              <TableCell className="whitespace-normal">{row.dataCategories}</TableCell>
              <TableCell className="whitespace-normal">{row.location}</TableCell>
              <TableCell className="whitespace-normal">{row.transferMechanism}</TableCell>
              <TableCell className="whitespace-normal">
                <a
                  href={row.dpa.href}
                  className="text-primary hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {row.dpa.label}
                </a>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

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
              categories of data it processes, where it&#39;s located, the mechanism we rely on for
              any international transfer of personal data, and the data-processing terms that govern
              the relationship. See our{" "}
              <a href="/privacy" className="text-primary hover:underline">Privacy Policy</a> for how
              this fits into our overall data-processing practices.
            </p>
            <p className="mb-4">
              All of our subprocessors are located in the United States. Every vendor that processes
              personal data on our behalf does so under a data processing agreement that incorporates
              the European Commission&#39;s Standard Contractual Clauses (Module 2, controller-to-processor)
              and the UK International Data Transfer Addendum, except where a different mechanism is
              noted below.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">Infrastructure</h2>
            <SubprocessorTable rows={infrastructure} />
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">Billing, email, monitoring, and notifications</h2>
            <SubprocessorTable rows={operations} />
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">AI model providers</h2>
            <p className="mb-4">
              AI model providers receive your prompts and the context you include on a per-request
              basis, only when you use an AI feature — see the Third-Party AI Services section of our{" "}
              <a href="/privacy" className="text-primary hover:underline">Privacy Policy</a>. We use
              each provider&#39;s API/business offering, under which Anthropic, OpenAI, Google, and xAI do
              not use your inputs to train their models. Models reached through OpenRouter are
              optional, only used when you explicitly select one, and are subject to the retention
              policy of the upstream provider, which OpenRouter publishes per model. PageSpace also
              supports Ollama as a fully on-premises/local model option that does not send data to any
              third party.
            </p>
            <SubprocessorTable rows={aiProviders} />
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">Optional integrations you authorize directly</h2>
            <p className="mb-4">
              These services are not subprocessors in the strict sense: when you connect one, you
              grant PageSpace access to data that the provider already holds about you, and the
              provider continues to act as an independent controller of your account with them. We
              list them here for completeness.
            </p>
            <SubprocessorTable rows={independentControllers} />
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
