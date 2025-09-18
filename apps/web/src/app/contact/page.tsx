"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import ContactForm from "@/components/shared/ContactForm";
import { ArrowLeft, Building } from "lucide-react";

export default function ContactPage() {
  return (
    <div className="flex flex-col min-h-screen">
      <header className="w-full border-b">
        <div className="container mx-auto flex h-14 items-center px-4 sm:px-6 lg:px-8">
          <Link className="flex items-center justify-center" href="/">
            <span className="text-xl font-semibold">PageSpace</span>
          </Link>
          <nav className="ml-auto">
            <Button asChild variant="ghost" size="sm">
              <Link href="/">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to Home
              </Link>
            </Button>
          </nav>
        </div>
      </header>
      <main className="flex-1 py-20">
        <div className="container mx-auto px-4 md:px-6 max-w-2xl">
          <div className="text-center mb-12">
            <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4">
              <Building className="w-6 h-6 text-primary" />
            </div>
            <h1 className="text-3xl font-bold tracking-tighter sm:text-4xl mb-4">
              Contact Sales
            </h1>
            <p className="text-lg text-muted-foreground max-w-md mx-auto">
              Ready to explore PageSpace for your organization? Let's discuss how we can help transform your workspace.
            </p>
          </div>
          <ContactForm />
        </div>
      </main>
    </div>
  );
}