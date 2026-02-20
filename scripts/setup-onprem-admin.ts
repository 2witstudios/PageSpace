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
 * 5. Provisions a Getting Started drive
 */

import { db, users, userAiSettings, eq } from '@pagespace/db';
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

  // Validate password strength
  if (password.length < 12) {
    console.error('Error: Password must be at least 12 characters long');
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
      console.log(`Admin user ${email} already exists.`);
    } else {
      // Promote to admin
      await db.update(users)
        .set({ role: 'admin', subscriptionTier: 'business' })
        .where(eq(users.id, existing.id));
      console.log(`Existing user ${email} promoted to admin with business tier.`);
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
    baseUrl: 'http://localhost:11434',
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
