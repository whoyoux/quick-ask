import { defineConfig } from 'drizzle-kit'

// `npm run db:generate` writes SQL migrations to drizzle/; the app applies them at startup.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/main/db/schema.ts',
  out: './drizzle'
})
