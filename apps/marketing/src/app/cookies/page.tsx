import { SiteNavbar } from "@/components/SiteNavbar";
import { SiteFooter } from "@/components/SiteFooter";
import { LegalTodo } from "@/components/LegalTodo";
import { pageMetadata, LEGAL_LAST_UPDATED } from "@/lib/metadata";

export const metadata = pageMetadata.cookies;

export default function CookiePolicy() {
  return (
    <div className="min-h-screen bg-background">
      <SiteNavbar />

      <div className="container mx-auto px-4 py-12 md:py-16 max-w-4xl">
        <div className="mb-8">
          <h1 className="text-4xl font-bold mb-2">Cookie Policy</h1>
          <p className="text-muted-foreground">Last updated: {LEGAL_LAST_UPDATED}</p>
        </div>

        <div className="prose prose-lg max-w-none dark:prose-invert">
          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">1. Introduction</h2>
            <p className="mb-4">
              This Cookie Policy explains how PageSpace uses cookies and similar technologies (such as
              browser local storage) when you use our service, and how you can control your
              preferences. See our <a href="/privacy" className="text-primary hover:underline">Privacy Policy</a> for
              how this fits into our overall data-processing practices.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">2. Strictly Necessary Cookies</h2>
            <p className="mb-4">
              These cookies are required for the service to function and cannot be switched off. They
              are always on and do not require consent under ePrivacy rules:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li><strong>Session cookie:</strong> an opaque session token that keeps you signed in between requests. Session tokens are hashed at rest and are never readable as plaintext credentials.</li>
              <li><strong><code>ps_consent</code>:</strong> stores your cookie-preference choices (necessary / analytics / preferences) so we don&#39;t re-ask on every visit. Expires after 1 year.</li>
              <li><strong><code>login_csrf</code>:</strong> a short-lived token that protects the sign-in flow against cross-site request forgery.</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">3. Analytics</h2>
            <p className="mb-4">
              With your consent, we use a first-party, self-hosted usage tracker — not a third-party
              analytics SDK — to understand how the product is used (e.g. feature usage, page views).
              Events are sent directly to our own backend, not to an external analytics vendor.
              Analytics is off by default, only fires once you opt in via the cookie banner, and is
              disabled entirely on self-hosted (on-premises) deployments.
            </p>
            <p className="mb-4">
              To distinguish returning devices for this first-party analytics, we may also store a
              device identifier in your browser&#39;s local storage.
            </p>
            <LegalTodo>confirm the exact analytics event schema, any additional cookie/local-storage key names beyond the consent and device-id storage described above, and how long device-identifier data is retained.</LegalTodo>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">4. Preferences</h2>
            <p className="mb-4">
              With your consent, this category enables optional third-party sign-in convenience
              features — currently, Google Identity Services (used for the &quot;Sign in with Google&quot;
              one-tap flow). Google may set its own cookies once this script loads. This category is
              off by default.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">5. No Third-Party Advertising Cookies</h2>
            <p className="mb-4">
              PageSpace does not use third-party advertising or cross-site tracking cookies, and we do
              not sell your data to advertisers.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">6. Managing Your Preferences</h2>
            <p className="mb-4">
              You can accept all cookies, reject all optional cookies, or customize your choices for
              Analytics and Preferences at any time using the cookie consent banner shown on your
              first visit. Necessary cookies cannot be disabled, since the service cannot function
              without them.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">7. Changes to This Policy</h2>
            <p className="mb-4">
              We may update this Cookie Policy from time to time. We will notify you of any changes by
              posting the new policy on this page and updating the &quot;Last updated&quot; date.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">8. Contact Us</h2>
            <p className="mb-4">
              If you have questions about this Cookie Policy, please contact us at{" "}
              <strong>hello@pagespace.ai</strong>.
            </p>
          </section>
        </div>
      </div>

      <SiteFooter />
    </div>
  );
}
