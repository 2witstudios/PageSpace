import { SiteNavbar } from "@/components/SiteNavbar";
import { SiteFooter } from "@/components/SiteFooter";
import { LegalTodo } from "@/components/LegalTodo";
import { pageMetadata, LEGAL_LAST_UPDATED } from "@/lib/metadata";

export const metadata = pageMetadata.privacy;

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-background">
      <SiteNavbar />

      <div className="container mx-auto px-4 py-12 md:py-16 max-w-4xl">
        <div className="mb-8">
          <h1 className="text-4xl font-bold mb-2">Privacy Policy</h1>
          <p className="text-muted-foreground">Last updated: {LEGAL_LAST_UPDATED}</p>
        </div>

        <div className="prose prose-lg max-w-none dark:prose-invert">
          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">1. Introduction</h2>
            <p className="mb-4">
              PageSpace is committed to protecting your privacy. This Privacy Policy explains how we collect, use, and protect information in our cloud-based workspace platform, and describes your rights under the General Data Protection Regulation (GDPR) and similar data protection laws.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">2. Who We Are (Data Controller)</h2>
            <p className="mb-4">
              PageSpace is operated by Jonathan Woodall, as a sole proprietorship, who is the data controller responsible for your personal data under this Privacy Policy.
            </p>
            <LegalTodo>legal entity name (if different from the above) and registered/postal address for the data controller.</LegalTodo>
            <p className="mb-4">
              <strong>Data Protection Officer (DPO):</strong> our recommended-default position is that a DPO is not required — GDPR Art 37 only mandates one where core activities involve large-scale, regular, and systematic monitoring of data subjects, or large-scale processing of special-category data, which is unlikely to describe PageSpace at its current size.
            </p>
            <LegalTodo>confirm current headcount and processing scale still support the &quot;no DPO required&quot; conclusion above; revisit as the company grows.</LegalTodo>
            <p className="mb-4">
              <strong>EU representative:</strong> PageSpace is operated from the United States and has no establishment in the EU. If we offer services to EU-based data subjects on more than an occasional basis, Art 27 GDPR likely requires us to appoint an EU representative (unless a recognized exemption applies, e.g. only occasional, low-risk processing).
            </p>
            <LegalTodo>confirm whether Art 27 applies given our actual EU user base, and if so, name an appointed EU representative — or document the exemption rationale if it does not apply.</LegalTodo>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">3. Cloud-Based Privacy Approach</h2>
            <p className="mb-4">
              PageSpace is designed with privacy and security as core principles:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li><strong>Secure Cloud Storage:</strong> Your data is stored in our cloud infrastructure with access controls and security logging</li>
              <li><strong>Authentication Security:</strong> Passwordless authentication via passkeys and magic links, with sessions managed using opaque tokens</li>
              <li><strong>Data Protection:</strong> Sensitive secrets like OAuth tokens for connected integrations are encrypted using AES-256-GCM encryption. Note that document content and chat messages are stored as plain text to enable search functionality</li>
              <li><strong>Transparency:</strong> Clear information about how we handle your data and what security measures we implement</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">4. Information We Collect</h2>
            <h3 className="text-xl font-semibold mb-3">4.1 Account and Content Data</h3>
            <p className="mb-4">
              Information we collect and store includes:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li>User account information (username, email)</li>
              <li>Pages, documents, and content you create (stored as plain text in our database)</li>
              <li>File organization and workspace structure</li>
              <li>Application settings and preferences</li>
              <li>Chat messages and AI conversation history (stored as plain text in our database)</li>
              <li>Usage analytics and subscription billing information (via Stripe)</li>
              <li>OAuth tokens for connected integrations such as Google Calendar and Google Drive (encrypted using AES-256-GCM)</li>
            </ul>

            <h3 className="text-xl font-semibold mb-3">4.2 Technical Information</h3>
            <p className="mb-4">
              We collect technical information to maintain and improve the service:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li>IP addresses and device information</li>
              <li>Browser type and version</li>
              <li>Error logs for troubleshooting</li>
              <li>Performance metrics for optimization</li>
              <li>Feature usage statistics</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">5. Lawful Basis for Processing</h2>
            <p className="mb-4">
              Under GDPR Art 6, we rely on the following lawful bases for each purpose we process personal data for. This is our recommended-default mapping:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li><strong>Account provision</strong> (creating and operating your account, storing your content) — <strong>Contract</strong> (Art 6(1)(b)): necessary to provide the service you signed up for</li>
              <li><strong>Billing and subscriptions</strong> — <strong>Contract</strong> (Art 6(1)(b)): necessary to perform our agreement with you</li>
              <li><strong>Security and audit logs</strong> — <strong>Legitimate interest</strong> (Art 6(1)(f)): protecting the service, our users, and detecting abuse</li>
              <li><strong>Marketing emails</strong> — <strong>Consent</strong> (Art 6(1)(a)): only sent if you opt in, and withdrawable at any time</li>
              <li><strong>AI processing</strong> (sending your prompts/content to AI providers) — <strong>Consent / Contract</strong>: providing AI features is part of the service you signed up for; where required, we also seek explicit consent</li>
            </ul>
            <LegalTodo>legal review of the legitimate-interest balancing test for security/audit logging, to confirm this mapping holds up to scrutiny.</LegalTodo>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">6. Third-Party AI Services</h2>
            <p className="mb-4">
              When you use AI features, we work with external AI providers, each subject to that provider&#39;s own privacy policy. Provider routing is managed by PageSpace at the deployment level — you no longer supply or store provider API keys yourself. Supported providers include:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li><strong>Model providers:</strong> your prompts and the relevant context are sent to AI model providers — including Anthropic (Claude), OpenAI (GPT), Google (Gemini), xAI (Grok), and, via the OpenRouter routing provider, additional third-party models — to generate responses. AI usage is metered against your plan&#39;s monthly credit allowance; Free plans use a curated set of models, and paid plans unlock the full catalogue.</li>
              <li><strong>Ollama (on-premises/local option):</strong> for self-hosted deployments, PageSpace supports Ollama, which runs models locally — your prompts and content never leave your own infrastructure when using this option.</li>
            </ul>
            <p className="mb-4">
              <strong>Important:</strong> When using AI services, we send your prompts and relevant context to AI providers to generate responses. We do not share your personal information or unrelated workspace data with AI providers.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">7. Data Processing and Storage</h2>
            <h3 className="text-xl font-semibold mb-3">7.1 Cloud Processing</h3>
            <p className="mb-4">
              Data processing occurs on our secure cloud infrastructure, including:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li>Content creation and editing</li>
              <li>Search and indexing</li>
              <li>File organization</li>
              <li>Real-time collaboration</li>
              <li>AI model inference through third-party providers</li>
            </ul>

            <h3 className="text-xl font-semibold mb-3">7.2 Database Storage</h3>
            <p className="mb-4">
              Your data is stored in our cloud database infrastructure with security measures appropriate for a service of this type, including:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li><strong>Access Controls:</strong> Database access is restricted to authorized services and personnel, with all operations logged for security analysis</li>
              <li><strong>Authentication Security:</strong> Passwordless authentication via passkeys and magic links</li>
              <li><strong>Secret Encryption:</strong> OAuth tokens for connected integrations and other application secrets are encrypted using AES-256-GCM</li>
              <li><strong>Connection Security:</strong> Database connections use secure protocols</li>
              <li><strong>Content Storage:</strong> Document content and chat messages are stored as plain text in our database to enable full-text search and collaboration features. This means content is not encrypted at rest in the database</li>
            </ul>
            <p className="mb-4">
              <strong>Note:</strong> Our logging infrastructure captures database operations, errors, and security events for troubleshooting and security analysis, but does not constitute real-time monitoring or intrusion detection.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">8. Data Sharing</h2>
            <p className="mb-4">
              PageSpace does not sell or rent your personal data. We may share your data only in these situations:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li>With AI service providers when you use AI features</li>
              <li>When you explicitly share or collaborate with other users</li>
              <li>With service providers who help us operate the platform (under strict confidentiality agreements) — see our <a href="/subprocessors" className="text-primary hover:underline">Subprocessors</a> page for the full list</li>
              <li>When required by law or to protect our legal rights</li>
              <li>In connection with a business transfer (merger, acquisition, etc.)</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">9. Data Security</h2>
            <p className="mb-4">
              We implement security measures appropriate for a cloud-based workspace service, including:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li><strong>Data in Transit:</strong> Secure HTTPS connections for all web traffic</li>
              <li><strong>Authentication Security:</strong> Passwordless authentication eliminates credential-based attack vectors</li>
              <li><strong>Session Management:</strong> Opaque session tokens with proper expiration and validation</li>
              <li><strong>Secret Protection:</strong> AES-256-GCM encryption for OAuth tokens and stored integration credentials</li>
              <li><strong>Database Access:</strong> Restricted access controls with comprehensive logging of operations, errors, and security events</li>
              <li><strong>Input Validation:</strong> Comprehensive sanitization and validation of user inputs</li>
              <li><strong>Rate Limiting:</strong> Protection against abuse and excessive API usage</li>
              <li><strong>CSRF Protection:</strong> Built-in protection against cross-site request forgery</li>
            </ul>
            <p className="mb-4">
              While we implement commercially reasonable security measures, no system is 100% secure. We encourage users to register passkeys on their devices, use secure email accounts, and follow good security practices. You are responsible for maintaining backups of critical data.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">10. Your Rights and Control</h2>
            <p className="mb-4">
              Under GDPR and similar laws, you have the following rights over your personal data:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li><strong>Access:</strong> All your data is accessible through the application interface</li>
              <li><strong>Modification (Rectification):</strong> Edit or update any content at any time</li>
              <li><strong>Deletion (Erasure):</strong> Delete individual items or your entire workspace</li>
              <li><strong>Export (Data Portability):</strong> Data export available by request - contact us for assistance</li>
              <li><strong>Restriction (Art 18):</strong> Request that we limit processing of your data in certain circumstances (e.g. while a dispute about accuracy is resolved)</li>
              <li><strong>Objection (Art 21):</strong> Object to processing based on legitimate interest, including for direct marketing purposes</li>
              <li><strong>Withdraw Consent (Art 7(3)):</strong> Where processing is based on consent (e.g. marketing emails), withdraw it at any time without affecting the lawfulness of processing before withdrawal</li>
              <li><strong>Complain to a supervisory authority (Art 13(2)(d)):</strong> You have the right to lodge a complaint with a data protection supervisory authority</li>
            </ul>
            <LegalTodo>name your supervisory authority if PageSpace is EU-established; otherwise state that this right applies to lodging a complaint with any EU Data Protection Authority (DPA), typically the one in the data subject&#39;s member state.</LegalTodo>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">11. Automated Decision-Making</h2>
            <p className="mb-4">
              We do not make solely-automated decisions that produce legal effects concerning you or similarly significantly affect you (GDPR Art 22).
            </p>
            <LegalTodo>confirm no such use case currently exists in the product (e.g. automatic billing-suspension or account-lockout logic that acts without human review) — revisit this statement if one is introduced.</LegalTodo>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">12. Children&#39;s Privacy</h2>
            <p className="mb-4">
              PageSpace is not intended for children under 13. We do not knowingly collect personal information from children under 13. If you believe a child has provided personal information, please contact us.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">13. Changes to This Policy</h2>
            <p className="mb-4">
              We may update this Privacy Policy from time to time. We will notify you of any changes by posting the new Privacy Policy on this page and updating the &quot;Last updated&quot; date.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">14. Data Retention</h2>
            <p className="mb-4">
              We retain different categories of data for different lengths of time, depending on why we hold it:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li><strong>Account and content data:</strong> retained while your account is active. Upon a deletion request, we complete erasure within 30 days (our internal Art 12(3) service-level target), except where we are required to retain specific records by law</li>
              <li><strong>Security and monitoring logs:</strong> retention varies by log type — API metrics, error logs, and AI-usage logs are kept for 90 days by default; system logs for 30 days; general user-activity logs for 180 days. Our tamper-evident security audit log and activity log are retained indefinitely because deleting entries would break the cryptographic hash chain that proves they haven&#39;t been altered — this is justified under GDPR Art 17(3)(b) as necessary for compliance with a legal obligation</li>
              <li><strong>Backups:</strong> retained separately from primary storage for disaster-recovery purposes</li>
            </ul>
            <LegalTodo>pull the exact backup retention day-count once it&#39;s documented — it is not currently codified alongside the other retention policies.</LegalTodo>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">15. International Users and Data Processing</h2>
            <p className="mb-4">
              PageSpace is operated from the United States. If you are accessing our services from outside the United States, including from the European Economic Area (EEA) or United Kingdom, your information will be transferred to, stored, and processed in the United States.
            </p>
            <p className="mb-4">
              Where we transfer personal data from the EEA or UK to the United States, we rely on the European Commission&#39;s Standard Contractual Clauses (SCCs) as our transfer mechanism, rather than relying on your consent alone. Our subprocessors are listed on our <a href="/subprocessors" className="text-primary hover:underline">Subprocessors</a> page.
            </p>
            <LegalTodo>confirm which SCC Module is used for each vendor relationship, and confirm whether any transfers can instead rely on an adequacy decision (e.g. the UK&#39;s adequacy regulations) rather than SCCs.</LegalTodo>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">16. Payment and Billing Information</h2>
            <p className="mb-4">
              When you purchase a subscription, payment processing is handled by Stripe, Inc. We do not store your credit card information on our servers. Stripe&#39;s privacy policy governs the collection and use of payment information.
            </p>
            <p className="mb-4">
              We receive and store information about your subscription status, billing history, and usage metrics necessary for providing our services and managing your account.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">17. Data Security Incidents</h2>
            <p className="mb-4">
              In the event of a personal data breach, we follow GDPR&#39;s two-part notification model:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li>We notify the competent supervisory authority without undue delay and, where feasible, within 72 hours of becoming aware of the breach (Art 33), unless the breach is unlikely to result in a risk to your rights and freedoms.</li>
              <li>Where a breach is likely to result in a <em>high</em> risk to your rights and freedoms, we also communicate it to you directly, without undue delay, in clear and plain language (Art 34). This notification has no fixed hour deadline, but we aim to act as quickly as the circumstances allow.</li>
            </ul>
            <p className="mb-4">
              Notifications will include information about the nature of the incident, the data affected, and the steps we are taking to address it.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">18. Records of Processing Activities</h2>
            <p className="mb-4">
              A full Records of Processing Activities (RoPA) register is maintained internally per GDPR Art 30. GDPR does not require us to publish this register, so it is not reproduced here.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">19. Contact Us</h2>
            <p className="mb-4">
              If you have any questions about this Privacy Policy or our privacy practices, please contact us at:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li><strong>Email:</strong> hello@pagespace.ai</li>
              <li><strong>Support:</strong> Available through the in-app help system</li>
              <li><strong>Community:</strong> <a href="https://pagespace.ai/s/ps_share_oihl5ivoscf0tzx26g0t74degxwi028t" className="text-primary hover:underline">AI Agent Hub</a></li>
            </ul>
            <p className="mb-4">
              For data protection requests (access, deletion, portability), please use the subject line &quot;Data Protection Request&quot; in your email.
            </p>
          </section>
        </div>
      </div>

      <SiteFooter />
    </div>
  );
}
