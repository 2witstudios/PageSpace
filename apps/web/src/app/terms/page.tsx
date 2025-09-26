import Link from "next/link";

export default function TermsOfService() {
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
          <h1 className="text-4xl font-bold mb-2">Terms of Service</h1>
          <p className="text-muted-foreground">Last updated: January 21, 2025</p>
        </div>

        <div className="prose prose-lg max-w-none dark:prose-invert">
          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">1. Acceptance of Terms</h2>
            <p className="mb-4">
              By accessing and using PageSpace (&quot;the Service&quot;), you accept and agree to be bound by these Terms of Service (&quot;Terms&quot;). If you do not agree to these Terms, you may not use the Service.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">2. Description of Service</h2>
            <p className="mb-4">
              PageSpace is a cloud-based workspace platform that allows users to organize content, collaborate with AI, and manage projects. The Service includes:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li>Document creation and editing</li>
              <li>File organization and management</li>
              <li>AI-powered assistance and content generation</li>
              <li>Real-time collaboration features</li>
              <li>Cloud data storage and processing</li>
              <li>Multi-user collaboration and sharing</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">3. Cloud Service Architecture</h2>
            <p className="mb-4">
              PageSpace operates as a cloud service, meaning:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li>Your data is securely stored on our cloud infrastructure</li>
              <li>You can access your workspace from anywhere with an internet connection</li>
              <li>We implement industry-standard security measures to protect your data</li>
              <li>AI processing is performed using cloud-based AI services</li>
              <li>Automatic backups and data redundancy for reliability</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">4. User Responsibilities</h2>
            <p className="mb-4">
              You are responsible for:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li>Maintaining the security of your account credentials</li>
              <li>Using the Service in compliance with these Terms</li>
              <li>Ensuring compliance with applicable laws</li>
              <li>Not using the Service for illegal or harmful purposes</li>
              <li>Respecting intellectual property rights</li>
              <li>Not attempting to compromise the security of the Service</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">5. AI Services</h2>
            <p className="mb-4">
              When using AI features:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li>AI processing is performed using third-party AI services</li>
              <li>Third-party AI services (OpenRouter, Google AI, Anthropic, etc.) have their own terms</li>
              <li>We may send your content to AI providers to process your requests</li>
              <li>AI-generated content should be reviewed for accuracy and appropriateness</li>
              <li>You retain ownership of content you create, including AI-assisted content</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">6. Intellectual Property</h2>
            <p className="mb-4">
              The PageSpace software and its original content are owned by Jonathan Woodall and protected by copyright and other intellectual property laws. Your content remains yours, and PageSpace does not claim ownership of user-generated content.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">7. Disclaimer of Warranties</h2>
            <p className="mb-4">
              THE SERVICE IS PROVIDED &quot;AS IS&quot; WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED. WE DISCLAIM ALL WARRANTIES, INCLUDING BUT NOT LIMITED TO MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">8. Limitation of Liability</h2>
            <p className="mb-4">
              IN NO EVENT SHALL JONATHAN WOODALL OR PAGESPACE BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES ARISING OUT OF OR IN CONNECTION WITH YOUR USE OF THE SERVICE.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">9. Open Source Components</h2>
            <p className="mb-4">
              PageSpace incorporates various open source components, each subject to their own licensing terms. A complete list of third-party licenses can be found in the software documentation.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">10. Changes to Terms</h2>
            <p className="mb-4">
              We reserve the right to modify these Terms at any time. Changes will be effective immediately upon posting. Your continued use of the Service constitutes acceptance of any changes.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">11. Subscription Services and Billing</h2>
            <h3 className="text-xl font-semibold mb-3">11.1 Subscription Plans</h3>
            <p className="mb-4">
              PageSpace offers the following subscription plans:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li><strong>Free Plan:</strong> 20 AI calls per day, 500MB storage, basic processing</li>
              <li><strong>Pro Plan ($29.99/month):</strong> 50 AI calls per day, 10 Extra Thinking calls, 2GB storage, priority processing</li>
              <li><strong>Business Plan ($199.99/month):</strong> 500 AI calls per day, 50 Extra Thinking calls, 50GB storage, enterprise features</li>
            </ul>

            <h3 className="text-xl font-semibold mb-3">11.2 Billing and Payment</h3>
            <ul className="list-disc pl-6 mb-4">
              <li>Subscriptions are billed monthly in advance via Stripe</li>
              <li>Payment is due immediately upon subscription activation</li>
              <li>Failed payments may result in service suspension</li>
              <li>You may cancel your subscription at any time through your account settings</li>
              <li>Cancellation takes effect at the end of your current billing period</li>
              <li>No refunds are provided for partial months of service</li>
            </ul>

            <h3 className="text-xl font-semibold mb-3">11.3 Usage Limits</h3>
            <p className="mb-4">
              Each subscription plan includes specific usage limits. Exceeding these limits may result in service throttling or temporary suspension until your next billing cycle.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">12. Service Availability</h2>
            <p className="mb-4">
              While we strive to provide reliable service, PageSpace is provided on an &quot;as-is&quot; basis:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li>We do not guarantee 100% uptime or uninterrupted service</li>
              <li>Scheduled maintenance will be announced in advance when possible</li>
              <li>We reserve the right to modify or discontinue features with reasonable notice</li>
              <li>Third-party AI services may experience their own outages affecting our service</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">13. Account Termination</h2>
            <h3 className="text-xl font-semibold mb-3">13.1 Termination by You</h3>
            <p className="mb-4">
              You may terminate your account at any time through your account settings. Upon termination:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li>Your subscription will be canceled at the end of the current billing period</li>
              <li>You will retain access to your data until account deletion</li>
              <li>You may request data export before account deletion by contacting support</li>
            </ul>

            <h3 className="text-xl font-semibold mb-3">13.2 Termination by Us</h3>
            <p className="mb-4">
              We may suspend or terminate your account for:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li>Violation of these Terms of Service</li>
              <li>Abuse of our services or excessive resource usage</li>
              <li>Illegal activities or harassment of other users</li>
              <li>Non-payment of subscription fees</li>
              <li>Extended inactivity (after 90 days notice)</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">14. Data and Privacy</h2>
            <p className="mb-4">
              Your use of PageSpace is also governed by our Privacy Policy. By using our service, you agree to our data collection and processing practices as described in the Privacy Policy.
            </p>
            <p className="mb-4">
              Upon account deletion, we will delete your personal data within 30 days, except where we are required to retain it by law or for legitimate business purposes (such as billing records).
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">15. Governing Law</h2>
            <p className="mb-4">
              These Terms of Service shall be governed by and construed in accordance with the laws of the State of Texas, without regard to its conflict of law provisions. Any disputes arising from these Terms or your use of the Service shall be resolved in the courts of Texas.
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">16. Contact Information</h2>
            <p className="mb-4">
              PageSpace is operated by Jonathan Woodall as a sole proprietorship. If you have any questions about these Terms, please contact us at:
            </p>
            <ul className="list-disc pl-6 mb-4">
              <li><strong>Email:</strong> 2witstudios@gmail.com</li>
              <li><strong>Support:</strong> Available through the in-app help system</li>
              <li><strong>Community:</strong> <a href="https://discord.gg/kve8qgzZ8x" className="text-primary hover:underline">PageSpace Discord</a></li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}