/**
 * Provider-neutral email delivery service.
 *
 * Application code (the lead-created subscriber and the explicit test send)
 * depends on this contract only: it never names a provider, never builds a
 * transport, and never handles credentials. Provider selection and
 * request-scoped credential decryption live in the resolver layer built at
 * composition time; the returned sender carries a neutral send policy that
 * describes whether an interrupted send may still complete.
 */

import { type Env } from '@/db/repository';
import { type InstallationEmailConfig } from '@/domain/schemas';
import {
  CredentialCipher,
  type CredentialCipherService,
} from '@/notifications/credential-cipher';
import { CredentialCryptoError } from '@/notifications/credential-crypto';
import {
  type EmailEnvelope,
  type EmailProvider as EmailProviderKind,
  type SendResult,
} from '@/notifications/email';
import { createCloudflareEmailProvider } from '@/notifications/providers/cloudflare';
import { createResendEmailProvider } from '@/notifications/providers/resend';
import { Context, Data, Effect, Layer } from 'effect';

export type EmailProviderPolicy = {
  /**
   * True when a timed-out send cannot be interrupted and may still complete
   * at the provider, so the application must stop launching new sends for the
   * current batch.
   */
  readonly timeoutIsUncancelable: boolean;
};

export type EmailProviderResolverService = {
  /**
   * Builds the sender for the saved selection only. Credential decryption is
   * request-scoped: nothing is cached in the layer or across calls.
   */
  readonly resolve: (
    email: InstallationEmailConfig,
  ) => Effect.Effect<EmailProviderService, EmailProviderUnavailable>;
};

export type EmailProviderService = {
  readonly kind: EmailProviderKind;
  readonly policy: EmailProviderPolicy;
  readonly send: (input: EmailSendInput) => Effect.Effect<SendResult>;
};

export type EmailSendInput = {
  readonly deliveryKey: string;
  readonly envelope: EmailEnvelope;
  readonly timeoutMs: number;
};

export class EmailProviderResolver extends Context.Service<
  EmailProviderResolver,
  EmailProviderResolverService
>()('EmailProviderResolver') {}

/**
 * The saved configuration cannot produce a sender (redacted reason only).
 */
export class EmailProviderUnavailable extends Data.TaggedError(
  'EmailProviderUnavailable',
)<{ readonly reason: string }> {}

const failureReason = (error: unknown): string => {
  if (error instanceof CredentialCryptoError) {
    return error.code === 'missing_key'
      ? 'resend_api_key_missing'
      : 'decrypt_failed';
  }

  return 'provider_unavailable';
};

const resolveProvider = (
  cipher: CredentialCipherService,
  binding: Env['EMAIL'],
  email: InstallationEmailConfig,
): Effect.Effect<EmailProviderService, EmailProviderUnavailable> =>
  Effect.gen(function* () {
    if (email.provider === 'disabled') {
      return yield* Effect.fail(
        new EmailProviderUnavailable({ reason: 'email_disabled' }),
      );
    }

    if (email.provider === 'cloudflare') {
      if (binding === undefined) {
        return yield* Effect.fail(
          new EmailProviderUnavailable({
            reason: 'cloudflare_binding_missing',
          }),
        );
      }

      return createCloudflareEmailProvider(binding);
    }

    const credential = email.credential;
    if (credential === null) {
      return yield* Effect.fail(
        new EmailProviderUnavailable({ reason: 'resend_api_key_missing' }),
      );
    }

    const apiKey = yield* cipher
      .decrypt(credential)
      .pipe(
        Effect.mapError(
          (error) =>
            new EmailProviderUnavailable({ reason: failureReason(error) }),
        ),
      );
    return createResendEmailProvider(apiKey);
  });

export const emailProviderResolverLayer = (
  environment: Env,
): Layer.Layer<EmailProviderResolver, never, CredentialCipher> =>
  Layer.effect(
    EmailProviderResolver,
    CredentialCipher.pipe(
      Effect.map((cipher) => ({
        resolve: (email) => resolveProvider(cipher, environment.EMAIL, email),
      })),
    ),
  );
