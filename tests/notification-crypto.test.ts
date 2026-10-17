import {
  LEGACY_CREDENTIAL_ENVELOPE,
  LEGACY_CREDENTIAL_KEY,
  LEGACY_CREDENTIAL_PLAINTEXT,
} from './credential-ciphertext.fixture';
import {
  CREDENTIAL_KEY_VERSION,
  CredentialCryptoError,
  decryptCredential,
  encryptCredential,
  type EncryptedCredential,
} from '@/notifications/credential-crypto';
import { describe, expect, test } from 'vitest';

const bytes = (fill: number): Uint8Array<ArrayBuffer> => {
  const value = new Uint8Array(32);
  value.fill(fill);
  return value;
};

const base64 = (value: Uint8Array): string =>
  Buffer.from(value).toString('base64');

const KEY = base64(bytes(7));
const OTHER_KEY = base64(bytes(9));

const scope = {
  provider: 'resend',
};

const encrypt = (secret: string, value = 're_test_key') =>
  encryptCredential(secret, { ...scope, value });

const decrypt = (secret: string, envelope: EncryptedCredential) =>
  decryptCredential(secret, { ...scope, envelope });

describe('credential encryption', () => {
  test('round-trips a provider key with base64 and hex root keys', async () => {
    const envelope = await encrypt(KEY);
    await expect(decrypt(KEY, envelope)).resolves.toBe('re_test_key');

    const hex = Buffer.from(bytes(3)).toString('hex');
    const hexEnvelope = await encrypt(hex, 're_hex_key');
    await expect(decrypt(hex, hexEnvelope)).resolves.toBe('re_hex_key');
  });

  test('uses a fresh nonce for every encryption', async () => {
    const first = await encrypt(KEY);
    const second = await encrypt(KEY);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.keyVersion).toBe(CREDENTIAL_KEY_VERSION);
  });

  test('fails closed on tampered ciphertext', async () => {
    const envelope = await encrypt(KEY);
    const raw = Buffer.from(envelope.ciphertext, 'base64');
    raw[0] = raw[0] === 0 ? 1 : 0;
    await expect(
      decrypt(KEY, { ...envelope, ciphertext: raw.toString('base64') }),
    ).rejects.toMatchObject({ code: 'decrypt_failed' });
  });

  test('fails closed when the root key is wrong or missing', async () => {
    const envelope = await encrypt(KEY);
    await expect(decrypt(OTHER_KEY, envelope)).rejects.toMatchObject({
      code: 'decrypt_failed',
    });
    await expect(encrypt('')).rejects.toMatchObject({ code: 'missing_key' });
    await expect(decrypt('', envelope)).rejects.toBeInstanceOf(
      CredentialCryptoError,
    );
  });

  test('rejects malformed keys and payloads', async () => {
    await expect(encrypt('short')).rejects.toMatchObject({
      code: 'invalid_key',
    });
    await expect(encrypt(base64(bytes(7)).slice(0, 12))).rejects.toMatchObject({
      code: 'invalid_key',
    });
    const envelope = await encrypt(KEY);
    await expect(
      decrypt(KEY, { ...envelope, keyVersion: 99 }),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
    await expect(
      decrypt(KEY, { ...envelope, nonce: 'not-base64!' }),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
    await expect(
      decrypt(KEY, { ...envelope, ciphertext: '' }),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  test('decrypts a pre-removal ciphertext fixture byte-for-byte', async () => {
    await expect(
      decryptCredential(LEGACY_CREDENTIAL_KEY, {
        envelope: LEGACY_CREDENTIAL_ENVELOPE,
        provider: 'resend',
      }),
    ).resolves.toBe(LEGACY_CREDENTIAL_PLAINTEXT);
  });

  test('keeps the legacy authenticated context and binds the provider', async () => {
    const envelope = await encrypt(KEY);
    await expect(
      decryptCredential(KEY, { ...scope, envelope, provider: 'cloudflare' }),
    ).rejects.toMatchObject({ code: 'decrypt_failed' });

    // New encryptions remain readable by the frozen v1 context, so an older
    // deployment can still read credentials written after the upgrade.
    await expect(decrypt(KEY, envelope)).resolves.toBe('re_test_key');
  });
});
