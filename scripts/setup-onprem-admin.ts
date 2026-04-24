#!/usr/bin/env tsx
/**
 * Setup script to create the first admin user for on-premise PageSpace deployment.
 *
 * Usage:
 *   pnpm setup:admin --email admin@clinic.local --name "Dr. Smith"
 *
 * This script:
 * 1. Creates a user with admin role and business-tier subscription
 * 2. Sets emailVerified (pre-verified for on-prem)
 * 3. Creates default Ollama AI settings
 * 4. Generates a one-time magic link for initial sign-in (no SMTP required)
 */

import { db } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { userAiSettings } from '@pagespace/db/schema/ai';
import { eq, and } from '@pagespace/db/operators';
import { createId } from '@paralleldrive/cuid2';
import { getOnPremUserDefaults, getOnPremOllamaSettings } from '@pagespace/lib/onprem-defaults';
import { createVerificationToken } from '@pagespace/lib/auth/verification-utils';
import { parseArgs } from 'node:util';

async function generateSetupLink(userId: string): Promise<string> {
  const token = await createVerificationToken({
    userId,
    type: 'magic_link',
    expiresInMinutes: 60,
  });
  const baseUrl = process.env.NEXTAUTH_URL || process.env.WEB_APP_URL || 'http://localhost:3000';
  return `${baseUrl}/api/auth/magic-link/verify?token=${token}`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
    },
  });

  if (!values.email || !values.name) {
    console.error('Usage: pnpm setup:admin --email <email> --name <name>');
    console.error('');
    console.error('Example:');
    console.error('  pnpm setup:admin --email admin@clinic.local --name "Dr. Smith"');
    process.exit(1);
  }

  const email = values.email.toLowerCase().trim();
  const name = values.name.trim();

  // Validate trimmed values are non-empty and email format is valid
  if (!email) {
    console.error('Error: --email cannot be blank or whitespace only');
    process.exit(1);
  }
  if (!name) {
    console.error('Error: --name cannot be blank or whitespace only');
    process.exit(1);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('Error: --email does not appear to be a valid email address');
    process.exit(1);
  }

  // Check if user already exists
  const existing = await db.query.users.findFirst({
    where: eq(users.email, email),
    columns: { id: true, role: true },
  });

  if (existing) {
    if (existing.role === 'admin') {
      const link = await generateSetupLink(existing.id);
      console.log(`Admin user ${email} already exists.`);
      console.log('');
      console.log('One-time sign-in link (expires in 60 minutes):');
      console.log(`  ${link}`);
    } else {
      // Promote to admin
      await db.update(users)
        .set({ role: 'admin', ...getOnPremUserDefaults() })
        .where(eq(users.id, existing.id));

      // Ensure default Ollama AI settings exist for promoted user
      const existingSettings = await db.query.userAiSettings.findFirst({
        where: and(eq(userAiSettings.userId, existing.id), eq(userAiSettings.provider, 'ollama')),
      });
      if (!existingSettings) {
        await db.insert(userAiSettings).values({
          id: createId(),
          userId: existing.id,
          ...getOnPremOllamaSettings(),
        });
      }

      const link = await generateSetupLink(existing.id);
      console.log(`Existing user ${email} promoted to admin with business tier.`);
      console.log('');
      console.log('One-time sign-in link (expires in 60 minutes):');
      console.log(`  ${link}`);
    }
    process.exit(0);
  }

  const userId = createId();

  await db.insert(users).values({
    id: userId,
    name,
    email,
    role: 'admin',
    emailVerified: new Date(),
    ...getOnPremUserDefaults(),
  });

  // Create default Ollama AI settings
  await db.insert(userAiSettings).values({
    id: createId(),
    userId,
    ...getOnPremOllamaSettings(),
  });

  const link = await generateSetupLink(userId);

  console.log('');
  console.log('Admin user created successfully!');
  console.log(`  Name:  ${name}`);
  console.log(`  Email: ${email}`);
  console.log(`  Role:  admin`);
  console.log(`  Tier:  business`);
  console.log('');
  console.log('One-time sign-in link (expires in 60 minutes):');
  console.log(`  ${link}`);
  console.log('');
  console.log('After initial sign-in, register a passkey for future logins.');
  console.log('For email-based magic links, configure SMTP in your environment.');

  process.exit(0);
}

main().catch((error) => {
  console.error('Failed to create admin user:', error);
  process.exit(1);
});
