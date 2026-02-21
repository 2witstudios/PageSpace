#!/usr/bin/env tsx
/**
 * Setup script to create the first admin user for on-premise PageSpace deployment.
 *
 * Usage:
 *   pnpm setup:admin --email admin@clinic.local --password "SecurePass123!" --name "Dr. Smith"
 *
 * This script:
 * 1. Creates a user with admin role and business-tier subscription
 * 2. Hashes the password with bcrypt (cost 12)
 * 3. Sets emailVerified (pre-verified for on-prem)
 * 4. Creates default Ollama AI settings
 */

import { db, users, userAiSettings, eq, and } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import bcrypt from 'bcryptjs';
import { BCRYPT_COST } from '@pagespace/lib/auth';
import { parseArgs } from 'node:util';

async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      password: { type: 'string' },
      name: { type: 'string' },
    },
  });

  if (!values.email || !values.password || !values.name) {
    console.error('Usage: pnpm setup:admin --email <email> --password <password> --name <name>');
    console.error('');
    console.error('Example:');
    console.error('  pnpm setup:admin --email admin@clinic.local --password "SecurePass123!" --name "Dr. Smith"');
    process.exit(1);
  }

  const email = values.email.toLowerCase().trim();
  const password = values.password;
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

  // Validate password strength
  if (password.length < 12) {
    console.error('Error: Password must be at least 12 characters long');
    process.exit(1);
  }
  if (Buffer.byteLength(password, 'utf8') > 72) {
    console.error('Error: Password must be at most 72 bytes (bcrypt limit)');
    process.exit(1);
  }
  if (!/[A-Z]/.test(password)) {
    console.error('Error: Password must contain at least one uppercase letter');
    process.exit(1);
  }
  if (!/[a-z]/.test(password)) {
    console.error('Error: Password must contain at least one lowercase letter');
    process.exit(1);
  }
  if (!/[0-9]/.test(password)) {
    console.error('Error: Password must contain at least one number');
    process.exit(1);
  }

  // Check if user already exists
  const existing = await db.query.users.findFirst({
    where: eq(users.email, email),
    columns: { id: true, role: true },
  });

  if (existing) {
    if (existing.role === 'admin') {
      console.log(`Admin user ${email} already exists. Password was not changed.`);
    } else {
      // Promote to admin and update password
      const hashedPassword = await bcrypt.hash(password, BCRYPT_COST);
      await db.update(users)
        .set({ role: 'admin', subscriptionTier: 'business', password: hashedPassword })
        .where(eq(users.id, existing.id));

      // Ensure default Ollama AI settings exist for promoted user
      const existingSettings = await db.query.userAiSettings.findFirst({
        where: and(eq(userAiSettings.userId, existing.id), eq(userAiSettings.provider, 'ollama')),
      });
      if (!existingSettings) {
        await db.insert(userAiSettings).values({
          id: createId(),
          userId: existing.id,
          provider: 'ollama',
          baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
        });
      }

      console.log(`Existing user ${email} promoted to admin with business tier and password updated.`);
    }
    process.exit(0);
  }

  const userId = createId();
  const hashedPassword = await bcrypt.hash(password, BCRYPT_COST);

  await db.insert(users).values({
    id: userId,
    name,
    email,
    password: hashedPassword,
    role: 'admin',
    emailVerified: new Date(),
    subscriptionTier: 'business',
  });

  // Create default Ollama AI settings
  await db.insert(userAiSettings).values({
    id: createId(),
    userId,
    provider: 'ollama',
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  });

  console.log('');
  console.log('Admin user created successfully!');
  console.log(`  Name:  ${name}`);
  console.log(`  Email: ${email}`);
  console.log(`  Role:  admin`);
  console.log(`  Tier:  business`);
  console.log('');
  console.log('You can now sign in at your PageSpace URL.');

  process.exit(0);
}

main().catch((error) => {
  console.error('Failed to create admin user:', error);
  process.exit(1);
});
