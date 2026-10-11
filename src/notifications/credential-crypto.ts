/**
 * AES-256-GCM envelope encryption for provider credentials.
 *
 * The root key is a deployment secret (EMAIL_SETTINGS_ENCRYPTION_KEY) that is
 * never stored in D1 or bundled into the browser. Each encryption uses a fresh
 * 96-bit nonce, and the authenticated additional data binds the ciphertext to
 * the workspace, provider, and envelope version, so a value copied between
 * workspaces or providers fails to decrypt.
 *
 * Failure semantics are closed: a missing, malformed, or wrong key and a
 * tampered payload all throw `CredentialCryptoError`. Plaintext lives only
 * inside the request that encrypted or decrypted it; it is never logged,
 * returned in a DTO, or persisted.
 */

export type CredentialCryptoErrorCode =
  'decrypt_failed' | 'invalid_key' | 'invalid_payload' | 'missing_key';

export class CredentialCryptoError extends Error {
  readonly code: CredentialCryptoErrorCode;

  constructor(code: CredentialCryptoErrorCode, message: string) {
    super(message);
    this.name = 'CredentialCryptoError';
    this.code = code;
  }
}

export const CREDENTIAL_KEY_VERSION = 1;

export type EncryptedCredential = {
  ciphertext: string;
  keyVersion: number;
  nonce: string;
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }

  return btoa(binary);
};

const fromBase64 = (value: string): null | Uint8Array<ArrayBuffer> => {
  if (value.length === 0 || !/^[\w+/=-]+$/u.test(value)) {
    return null;
  }

  try {
    const binary = atob(value);
    return Uint8Array.from(
      binary,
      (character) => character.codePointAt(0) ?? 0,
    );
  } catch {
    return null;
  }
};

const HEX_KEY = /^[\da-fA-F]{64}$/u;

const decodeRootKey = (secret: string): Uint8Array<ArrayBuffer> => {
  const trimmed = secret.trim();
  if (trimmed.length === 0) {
    throw new CredentialCryptoError(
      'missing_key',
      'EMAIL_SETTINGS_ENCRYPTION_KEY is not configured.',
    );
  }

  if (HEX_KEY.test(trimmed)) {
    const bytes = new Uint8Array(32);
    for (let index = 0; index < 32; index += 1) {
      bytes[index] = Number.parseInt(
        trimmed.slice(index * 2, index * 2 + 2),
        16,
      );
    }

    return bytes;
  }

  const decoded = fromBase64(trimmed);
  if (decoded === null || decoded.byteLength !== 32) {
    throw new CredentialCryptoError(
      'invalid_key',
      'EMAIL_SETTINGS_ENCRYPTION_KEY must be a 32-byte key encoded as base64 or hex.',
    );
  }

  return decoded;
};

const importRootKey = async (secret: string): Promise<CryptoKey> => {
  const bytes = decodeRootKey(secret);
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, [
    'decrypt',
    'encrypt',
  ]);
};

const additionalData = (
  workspaceId: string,
  provider: string,
): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(
    `leadscroll:email-credential:v${CREDENTIAL_KEY_VERSION}:${workspaceId}:${provider}`,
  );

/**
 * Encrypts a provider API key. The returned envelope contains only public
 * metadata plus ciphertext; the plaintext is not retained.
 */
export const encryptCredential = async (
  secret: string,
  input: { provider: string; value: string; workspaceId: string },
): Promise<EncryptedCredential> => {
  const key = await importRootKey(secret);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      additionalData: additionalData(input.workspaceId, input.provider),
      iv: nonce,
      name: 'AES-GCM',
    },
    key,
    new TextEncoder().encode(input.value),
  );

  return {
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    keyVersion: CREDENTIAL_KEY_VERSION,
    nonce: toBase64(nonce),
  };
};

/**
 * Decrypts a stored provider API key. Any key or payload mismatch surfaces as
 * `decrypt_failed`; callers must treat it as a configuration fault and never
 * retry the ciphertext against another key.
 */
export const decryptCredential = async (
  secret: string,
  input: {
    envelope: EncryptedCredential;
    provider: string;
    workspaceId: string;
  },
): Promise<string> => {
  if (input.envelope.keyVersion !== CREDENTIAL_KEY_VERSION) {
    throw new CredentialCryptoError(
      'invalid_payload',
      'The stored credential uses an unsupported key version.',
    );
  }

  const nonce = fromBase64(input.envelope.nonce);
  const ciphertext = fromBase64(input.envelope.ciphertext);
  if (
    nonce === null ||
    nonce.byteLength !== 12 ||
    ciphertext === null ||
    ciphertext.byteLength === 0
  ) {
    throw new CredentialCryptoError(
      'invalid_payload',
      'The stored credential is malformed.',
    );
  }

  const key = await importRootKey(secret);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        additionalData: additionalData(input.workspaceId, input.provider),
        iv: nonce,
        name: 'AES-GCM',
      },
      key,
      ciphertext,
    );
  } catch {
    throw new CredentialCryptoError(
      'decrypt_failed',
      'The stored credential could not be decrypted with the configured key.',
    );
  }

  return new TextDecoder().decode(plaintext);
};
