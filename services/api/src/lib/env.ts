import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string().default("postgres://partmov:partmov@127.0.0.1:5432/partmov"),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  MINIO_ENDPOINT: z.string().default("127.0.0.1"),
  MINIO_PORT: z.coerce.number().default(9000),
  MINIO_USE_SSL: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  MINIO_ACCESS_KEY: z.string().default("partmov"),
  MINIO_SECRET_KEY: z.string().default("partmovsecret"),
  MINIO_BUCKET_ORIGINALS: z.string().default("originals"),
  MINIO_BUCKET_RENDITIONS: z.string().default("renditions"),
  MEDIA_PUBLIC_BASE: z.string().default("http://127.0.0.1:8088/hls"),
  MEDIA_HMAC_SECRET: z.string().default("dev-media-hmac-change-me"),
  SESSION_HMAC_SECRET: z.string().default("dev-session-hmac-change-me"),
  PUBLIC_APP_URL: z.string().default("http://127.0.0.1:3000"),
  ENCODER_VERSION: z.string().default("partmov-ffmpeg-v1"),
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);
