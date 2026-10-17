import { type EncryptedCredential } from '@/notifications/credential-crypto';

/**
 * A ciphertext produced by the credential crypto implementation from the
 * earlier workspace-scoped epoch (`encryptCredential` with the default
 * workspace id). The envelope is kept verbatim so the test proves that the
 * squashed baseline does not require re-encrypting existing credentials.
 */
export const LEGACY_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString('base64');

export const LEGACY_CREDENTIAL_PLAINTEXT = 're_legacy_fixture_key';

export const LEGACY_CREDENTIAL_ENVELOPE: EncryptedCredential = {
  ciphertext: 'tzWOXZX52qsroWky2sD/eVB3T3oA/zBiiHXwTfaZNTLHjBR7EA==',
  keyVersion: 1,
  nonce: 'x5zkClWhobVmv450',
};
