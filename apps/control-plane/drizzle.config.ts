import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.CONTROL_PLANE_DATABASE_URL || 'postgresql://localhost:5432/pagespace_control',
  },
})
