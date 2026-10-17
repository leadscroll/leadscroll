/**
 * Request-scoped provider credential encryption service.
 *
 * The deployment root key stays in the composition layer; business effects
 * only ask for encrypt/decrypt operations, and decrypted plaintext never
 * leaves the call that needs it.
 */

import { type Env } from '@/db/repository';
import { type EncryptedCredential } from '@/domain/schemas';
import {
  CredentialCryptoError,
  decryptCredential,
  encryptCredential,
} from '@/notifications/credential-crypto';
import { Context, Effect, Layer } from 'effect';

export type CredentialCipherService = {
  readonly configured: boolean;
  readonly decrypt: (
    envelope: EncryptedCredential,
  ) => Effect.Effect<string, CredentialCryptoError>;
  readonly encrypt: (
    value: string,
  ) => Effect.Effect<EncryptedCredential, CredentialCryptoError>;
};

export class CredentialCipher extends Context.Tag('CredentialCipher')<
  CredentialCipher,
  CredentialCipherService
>() {}

const asCryptoError = (
  cause: unknown,
  fallback: 'decrypt_failed' | 'invalid_key',
): CredentialCryptoError =>
  cause instanceof CredentialCryptoError
    ? cause
    : new CredentialCryptoError(
        fallback,
        'The email credential could not be processed.',
      );

export const credentialCipherLayer = (
  environment: Env,
): Layer.Layer<CredentialCipher> => {
  const secret = environment.EMAIL_SETTINGS_ENCRYPTION_KEY ?? '';
  return Layer.succeed(CredentialCipher, {
    configured: secret.trim() !== '',
    decrypt: (envelope) =>
      Effect.tryPromise({
        catch: (cause) => asCryptoError(cause, 'decrypt_failed'),
        try: () => decryptCredential(secret, { envelope, provider: 'resend' }),
      }),
    encrypt: (value) =>
      Effect.tryPromise({
        catch: (cause) => asCryptoError(cause, 'invalid_key'),
        try: () => encryptCredential(secret, { provider: 'resend', value }),
      }),
  });
};
