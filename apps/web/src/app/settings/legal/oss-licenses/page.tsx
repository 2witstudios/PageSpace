"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, ExternalLink } from "lucide-react";

interface Attribution {
  name: string;
  license: string;
  note: string;
  upstream?: { label: string; href: string };
}

const MPL_ATTRIBUTIONS: Attribution[] = [
  {
    name: "@capgo/capacitor-social-login",
    license: "MPL-2.0",
    note: "Direct production dependency used in the iOS and Android builds to provide Apple and Google sign-in. Shipped unmodified.",
    upstream: {
      label: "github.com/Cap-go/capacitor-social-login",
      href: "https://github.com/Cap-go/capacitor-social-login",
    },
  },
];

const OTHER_ATTRIBUTIONS: Attribution[] = [
  {
    name: "@fontsource/ibm-plex-mono",
    license: "OFL-1.1",
    note: "IBM Plex Mono font files bundled with the application UI.",
    upstream: {
      label: "github.com/IBM/plex",
      href: "https://github.com/IBM/plex",
    },
  },
  {
    name: "@fontsource/space-grotesk",
    license: "OFL-1.1",
    note: "Space Grotesk font files bundled with the application UI.",
    upstream: {
      label: "github.com/floriankarsten/space-grotesk",
      href: "https://github.com/floriankarsten/space-grotesk",
    },
  },
  {
    name: "@img/sharp-libvips",
    license: "LGPL-3.0",
    note: "Native libvips binaries consumed via sharp for image processing. Dynamically loaded; unmodified.",
    upstream: {
      label: "github.com/lovell/sharp-libvips",
      href: "https://github.com/lovell/sharp-libvips",
    },
  },
  {
    name: "dompurify",
    license: "Apache-2.0 (elected; available under MPL-2.0 OR Apache-2.0)",
    note: "HTML sanitization library. PageSpace formally elects Apache-2.0.",
    upstream: {
      label: "github.com/cure53/DOMPurify",
      href: "https://github.com/cure53/DOMPurify",
    },
  },
  {
    name: "jszip",
    license: "MIT (elected; available under MIT OR GPL-3.0-or-later)",
    note: "ZIP archive reader/writer. PageSpace formally elects MIT.",
    upstream: {
      label: "github.com/Stuk/jszip",
      href: "https://github.com/Stuk/jszip",
    },
  },
];

function AttributionList({ items }: { items: Attribution[] }) {
  return (
    <ul className="space-y-4">
      {items.map((item) => (
        <li key={item.name} className="border-l-2 border-muted pl-4">
          <div className="font-mono text-sm font-semibold">{item.name}</div>
          <div className="text-sm text-muted-foreground">{item.license}</div>
          <p className="mt-1 text-sm">{item.note}</p>
          {item.upstream && (
            <a
              href={item.upstream.href}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              {item.upstream.label}
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function OssLicensesPage() {
  const router = useRouter();

  return (
    <div className="container mx-auto py-10 px-10 max-w-4xl">
      <div className="mb-8">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/settings")}
          className="mb-4"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Settings
        </Button>
        <h1 className="text-3xl font-bold mb-2">Open-source licenses</h1>
        <p className="text-muted-foreground">
          Third-party open-source software used in PageSpace and the attribution
          notices required by those licenses.
        </p>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>MPL-2.0 attribution</CardTitle>
          <CardDescription>
            Required recipient notice under Mozilla Public License 2.0 §3.2 for
            Covered Software distributed as part of a Larger Work.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AttributionList items={MPL_ATTRIBUTIONS} />
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Other notable attributions</CardTitle>
          <CardDescription>
            Additional third-party components with attribution, font, or dual-license
            notices worth surfacing in the application.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AttributionList items={OTHER_ATTRIBUTIONS} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Full inventory</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            The list above is not exhaustive. It covers the third-party components
            whose licenses carry specific attribution obligations worth surfacing
            in the application itself.
          </p>
          <p>
            The complete open-source inventory — every direct and transitive
            dependency across the web, desktop, iOS, and Android builds, with the
            SPDX identifier for each — is maintained in the seller&rsquo;s IP
            disclosure and is available to recipients on request.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
