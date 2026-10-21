/* eslint-disable unicorn/prevent-abbreviations -- The repository layout names this binding module env.ts. */
import { type Database } from './driver';

export type Env = {
  ASSETS: Fetcher;
  BETTER_AUTH_SECRET: string;
  // Optional canonical origin override. When absent or blank, authentication
  // uses the incoming request URL's origin; production requires HTTPS.
  BETTER_AUTH_URL?: string;
  DB: Database;
  // Development/test-only identity bypass. Never honored in production.
  DEV_ADMIN_EMAIL?: string;
  // Optional native Cloudflare Email Sending binding. Declared by standard
  // installations and invoked only when the saved provider is `cloudflare`;
  // disabled/Resend paths must never call or probe it.
  EMAIL?: Pick<SendEmail, 'send'>;
  // Dedicated AES-256-GCM root key for UI-entered provider credentials. Not
  // required by the base CRM; absent means credential writes and sends fail
  // closed while Disable and ordinary CRM features keep working.
  EMAIL_SETTINGS_ENCRYPTION_KEY?: string;
  ENVIRONMENT: 'development' | 'production' | 'test';
  // Optional opt-in OTLP/HTTP trace export. When no endpoint is set, tracing
  // stays off and Workers Logs remains the only telemetry sink. Headers are
  // secret-bearing and are never logged. Sampling applies to root spans only.
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?: string;
  OTEL_SERVICE_NAME?: string;
  OTEL_TRACES_SAMPLER?: string;
  OTEL_TRACES_SAMPLER_ARG?: string;
  // Invite token required to create a staff account (X-Setup-Token header on
  // POST /api/auth/sign-up/email). Unset or empty rejects every sign-up.
  SETUP_TOKEN?: string;
};
