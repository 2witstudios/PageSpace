import Link from "next/link";

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        <div className="mb-8">
          <Link
            href="/"
            className="text-primary hover:underline mb-4 inline-block"
          >
            ← Back to Home
          </Link>
          <h1 className="text-4xl font-bold mb-2">Privacy Policy</h1>
          <p className="text-muted-foreground">Last updated: January 21, 2025</p>
        </div>

        <div className="prose prose-lg max-w-none dark:prose-invert">
          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">1. Introduction</h2>
            <p className="mb-4">
              PageSpace is committed to protecting your privacy. This Privacy Policy explains how we collect, use, and protect information in our cloud-based workspace platform.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">2. Cloud-Based Privacy Approach</h2>
            <p className="mb-4">
              PageSpace is designed with privacy and security as core principles:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li><strong>Secure Cloud Storage:</strong> Your data is stored securely in our cloud infrastructure with access controls and monitoring</li>
              <li><strong>Authentication Security:</strong> Passwords are securely hashed using bcrypt, and sessions are managed with JWT tokens</li>
              <li><strong>Data Protection:</strong> Sensitive information like API keys is encrypted using AES-256-GCM encryption</li>
              <li><strong>Transparency:</strong> Clear information about how we handle your data and what security measures we implement</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">3. Information We Collect</h2>
            <h3 className="text-xl font-semibold mb-3">3.1 Account and Content Data</h3>
            <p className="mb-4">
              Information we collect and store includes:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li>User account information (username, email, securely hashed password)</li>
              <li>Pages, documents, and content you create (stored as plain text in our database)</li>
              <li>File organization and workspace structure</li>
              <li>Application settings and preferences</li>
              <li>Chat messages and AI conversation history (stored as plain text in our database)</li>
              <li>Usage analytics and subscription billing information (via Stripe)</li>
              <li>Your personal API keys for AI services (encrypted using AES-256-GCM)</li>
            </ul>

            <h3 className="text-xl font-semibold mb-3">3.2 Technical Information</h3>
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
            <h2 className="text-2xl font-semibold mb-4">4. Third-Party AI Services</h2>
            <p className="mb-4">
              When you use AI features, we work with external AI providers:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li><strong>OpenRouter:</strong> Subject to OpenRouter&apos;s privacy policy</li>
              <li><strong>Google AI:</strong> Subject to Google&apos;s privacy policy</li>
              <li><strong>Anthropic (Claude):</strong> Subject to Anthropic&apos;s privacy policy</li>
              <li><strong>OpenAI:</strong> Subject to OpenAI&apos;s privacy policy</li>
            </ul>
            <p className="mb-4">
              <strong>Important:</strong> When using AI services, we send your prompts and relevant context to AI providers to generate responses. We do not share your personal information or unrelated workspace data with AI providers.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">5. Data Processing and Storage</h2>
            <h3 className="text-xl font-semibold mb-3">5.1 Cloud Processing</h3>
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

            <h3 className="text-xl font-semibold mb-3">5.2 Database Storage</h3>
            <p className="mb-4">
              Your data is stored in our cloud database infrastructure with industry-standard security measures, including:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li><strong>Access Controls:</strong> Database access is restricted and monitored</li>
              <li><strong>Password Security:</strong> User passwords are securely hashed using bcrypt</li>
              <li><strong>API Key Encryption:</strong> Personal AI service API keys are encrypted using AES-256-GCM</li>
              <li><strong>Connection Security:</strong> Database connections use secure protocols</li>
              <li><strong>Content Storage:</strong> Document content and chat messages are currently stored as plain text in our database</li>
            </ul>
            <p className="mb-4">
              <strong>Note:</strong> For enhanced security needs, consider our self-hosted deployment option where you have full control over data encryption and storage.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">6. Data Sharing</h2>
            <p className="mb-4">
              PageSpace does not sell or rent your personal data. We may share your data only in these situations:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li>With AI service providers when you use AI features</li>
              <li>When you explicitly share or collaborate with other users</li>
              <li>With service providers who help us operate the platform (under strict confidentiality agreements)</li>
              <li>When required by law or to protect our legal rights</li>
              <li>In connection with a business transfer (merger, acquisition, etc.)</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">7. Data Security</h2>
            <p className="mb-4">
              We implement comprehensive security measures including:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li><strong>Data in Transit:</strong> Secure HTTPS connections for all web traffic</li>
              <li><strong>Password Security:</strong> bcrypt hashing with salt rounds for user passwords</li>
              <li><strong>Session Management:</strong> JWT tokens with proper expiration and validation</li>
              <li><strong>API Key Protection:</strong> AES-256-GCM encryption for user-provided AI service keys</li>
              <li><strong>Database Access:</strong> Restricted access controls and connection monitoring</li>
              <li><strong>Input Validation:</strong> Comprehensive sanitization and validation of user inputs</li>
              <li><strong>Rate Limiting:</strong> Protection against abuse and excessive API usage</li>
              <li><strong>CSRF Protection:</strong> Built-in protection against cross-site request forgery</li>
            </ul>
            <p className="mb-4">
              While we implement strong security measures, no system is 100% secure. We encourage users to use strong passwords and follow good security practices.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">8. Your Rights and Control</h2>
            <p className="mb-4">
              You have complete control over your data:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li><strong>Access:</strong> All your data is accessible through the application interface</li>
              <li><strong>Modification:</strong> Edit or update any content at any time</li>
              <li><strong>Deletion:</strong> Delete individual items or your entire workspace</li>
              <li><strong>Export:</strong> Data export available by request - contact us for assistance</li>
              <li><strong>Portability:</strong> Your data is stored in standard formats</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">9. Children&apos;s Privacy</h2>
            <p className="mb-4">
              PageSpace is not intended for children under 13. We do not knowingly collect personal information from children under 13. If you believe a child has provided personal information, please contact us.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">10. Changes to This Policy</h2>
            <p className="mb-4">
              We may update this Privacy Policy from time to time. We will notify you of any changes by posting the new Privacy Policy on this page and updating the &quot;Last updated&quot; date.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">11. Data Retention</h2>
            <p className="mb-4">
              We retain your data for as long as:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li>Your account remains active</li>
              <li>Needed to provide you with services</li>
              <li>Required by law or for legitimate business purposes</li>
            </ul>
            <p className="mb-4">
              When you delete your account, we will delete your personal data within a reasonable timeframe, except where we are required to retain it by law.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">12. International Users and Data Processing</h2>
            <p className="mb-4">
              PageSpace is operated from the United States. If you are accessing our services from outside the United States, please be aware that your information may be transferred to, stored, and processed in the United States where our servers are located and our central database is operated.
            </p>
            <p className="mb-4">
              By using our service, you consent to the transfer of your information to the United States and processing in accordance with this Privacy Policy.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">13. Payment and Billing Information</h2>
            <p className="mb-4">
              When you purchase a subscription, payment processing is handled by Stripe, Inc. We do not store your credit card information on our servers. Stripe's privacy policy governs the collection and use of payment information.
            </p>
            <p className="mb-4">
              We receive and store information about your subscription status, billing history, and usage metrics necessary for providing our services and managing your account.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">14. Data Security Incidents</h2>
            <p className="mb-4">
              In the event of a data security incident that affects your personal information, we will notify affected users via email within 72 hours of discovering the incident, in accordance with applicable data protection laws.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">15. Contact Us</h2>
            <p className="mb-4">
              If you have any questions about this Privacy Policy or our privacy practices, please contact us at:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li><strong>Email:</strong> 2witstudios@gmail.com</li>
              <li><strong>Support:</strong> Available through the in-app help system</li>
              <li><strong>Community:</strong> <a href="https://discord.gg/kve8qgzZ8x" className="text-primary hover:underline">PageSpace Discord</a></li>
            </ul>
            <p className="mb-4">
              For data protection requests (access, deletion, portability), please use the subject line "Data Protection Request" in your email.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}