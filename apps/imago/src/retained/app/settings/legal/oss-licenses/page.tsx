"use client";

import { ExternalLink } from "lucide-react";
import {
  SettingsGroup,
  SettingsRow,
  SettingsScreen,
  SettingsSection,
} from "@/ui/settings/settings-screen/settings-screen";

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
    note: "Direct production dependency used in the mobile app builds to provide Apple and Google sign-in. Shipped unmodified.",
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

function AttributionGroup({ items }: { items: Attribution[] }) {
  return (
    <SettingsGroup>
      {items.map((item) => (
        <SettingsRow
          key={item.name}
          label={<span className="font-mono">{item.name}</span>}
          hint={
            <span className="flex flex-col gap-1">
              <span>{item.license}</span>
              <span>{item.note}</span>
            </span>
          }
        >
          {item.upstream && (
            <a
              href={item.upstream.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-accent-deep hover:underline"
            >
              {item.upstream.label}
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}

export default function OssLicensesPage() {
  return (
    <SettingsScreen
      title="Open-source licenses"
      lede="Third-party open-source software used in PageSpace, and the attribution notices their licenses require."
    >
      <SettingsSection
        title="MPL-2.0 attribution"
        description="Required recipient notice under Mozilla Public License 2.0 §3.2 for Covered Software distributed as part of a Larger Work."
      >
        <AttributionGroup items={MPL_ATTRIBUTIONS} />
      </SettingsSection>

      <SettingsSection
        title="Other notable attributions"
        description="Additional third-party components with attribution, font, or dual-license notices worth surfacing in the application."
      >
        <AttributionGroup items={OTHER_ATTRIBUTIONS} />
      </SettingsSection>

      <SettingsSection
        title="Full inventory"
        description={
          <>
            The lists above are not exhaustive. They cover the third-party components whose licenses carry
            specific attribution obligations worth surfacing in the application itself. The complete inventory,
            with the license identifier for every direct and transitive dependency, is published in the
            open-source PageSpace repository:
          </>
        }
      >
        <a
          href="https://github.com/2witstudios/PageSpace/blob/master/OSS-INVENTORY.md"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm text-accent-deep hover:underline"
        >
          OSS-INVENTORY.md
          <ExternalLink className="h-3 w-3" />
        </a>
      </SettingsSection>
    </SettingsScreen>
  );
}
