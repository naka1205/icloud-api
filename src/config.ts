import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? 8081 : parseInt(v, 10)))
    .refine((v) => Number.isInteger(v) && v > 0 && v < 65536, 'PORT must be 1-65535'),
  HOST: z.string().optional().default('0.0.0.0'),
  DATA_DIR: z.string().optional().default('./data'),
  LOG_LEVEL: z.string().optional().default('info'),
  NODE_ENV: z.string().optional(),
  ICLOUD_API_ADMIN_PASSWORD: z.string().min(8, 'ICLOUD_API_ADMIN_PASSWORD must be at least 8 characters'),
  ICLOUD_API_SESSION_TTL: z.string().optional(),
  ICLOUD_API_SECURE_COOKIE: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

export type EnvConfig = z.infer<typeof envSchema>;

/**
 * Read and validate environment config. Throws (and refuses to start) when
 * ICLOUD_API_ADMIN_PASSWORD is missing or shorter than 8 characters, matching
 * Go main.go. The password is removed from process.env after reading, so it
 * cannot leak into child processes or error output.
 */
export function getEnvConfig(): EnvConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`Invalid environment: ${first.path.join('.')}: ${first.message}`);
  }
  const cfg = parsed.data;
  delete process.env.ICLOUD_API_ADMIN_PASSWORD;
  return cfg;
}
