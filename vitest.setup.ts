import { config as loadEnv } from "dotenv";

// Same precedence Next.js uses. Vitest does not load .env files on its own.
loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });
