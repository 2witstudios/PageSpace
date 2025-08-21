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
          <p className="text-muted-foreground">Last updated: August 20, 2025</p>
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
              The PageSpace software and its original content are owned by PageSpace and protected by copyright and other intellectual property laws. Your content remains yours, and PageSpace does not claim ownership of user-generated content.
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
              IN NO EVENT SHALL PAGESPACE BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES ARISING OUT OF OR IN CONNECTION WITH YOUR USE OF THE SERVICE.
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
            <h2 className="text-2xl font-semibold mb-4">11. Contact Information</h2>
            <p className="mb-4">
              If you have any questions about these Terms, please contact us through the PageSpace community or support channels.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}