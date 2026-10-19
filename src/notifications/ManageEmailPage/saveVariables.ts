/**
 * Form-value translation for Manage -> Email. Kept separate from the React
 * component so the secret-free mutation contract is directly testable: React
 * Query mutation variables never contain the Resend API key, and the request
 * is assembled around a request-scoped secret reference.
 *
 * A stored key is represented by a fixed sentinel in the password field. The
 * sentinel is not a credential: an unchanged value maps to `keep`, any other
 * non-empty value maps to `replace`, and removal has its own explicit action.
 */

import { type UpdateEmailSettingsRequest } from '@/domain/schemas';

export const STORED_API_KEY_SENTINEL = '••••••••••••';

export type ManageEmailFormValues = {
  apiKey: string;
  fromEmail: string;
  fromName: string;
  provider: 'cloudflare' | 'disabled' | 'resend';
  removeKey: boolean;
};

export type SaveSettingsVariables = {
  apiKeyUnchanged: boolean;
  expectedRevision: number;
  fromEmail: null | string;
  fromName: null | string;
  provider: 'cloudflare' | 'disabled' | 'resend';
  removeKey: boolean;
};

const trimmedOrNull = (value: string): null | string => {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

export const toFormValues = (settings: {
  fromEmail: null | string;
  fromName: null | string;
  hasApiKey: boolean;
  provider: 'cloudflare' | 'disabled' | 'resend';
}): ManageEmailFormValues => ({
  apiKey: settings.hasApiKey ? STORED_API_KEY_SENTINEL : '',
  fromEmail: settings.fromEmail ?? '',
  fromName: settings.fromName ?? '',
  provider: settings.provider,
  removeKey: false,
});

/**
 * Builds the mutation variables. The API key is deliberately absent; the
 * caller passes only non-secret fields and reads the secret separately at the
 * request boundary.
 */
export const toSaveVariables = (
  values: ManageEmailFormValues,
  expectedRevision: number,
): SaveSettingsVariables => ({
  apiKeyUnchanged: values.apiKey === STORED_API_KEY_SENTINEL,
  expectedRevision,
  fromEmail: trimmedOrNull(values.fromEmail),
  fromName: trimmedOrNull(values.fromName),
  provider: values.provider,
  removeKey: values.removeKey,
});

/**
 * Returns a human message for an unusable key draft, or null when the draft is
 * valid. An empty field is not treated as removal: removal is explicit so a
 * stray backspace cannot delete the stored credential.
 */
export const apiKeyValidationError = (
  values: ManageEmailFormValues,
  hasStoredKey: boolean,
): null | string => {
  if (values.provider !== 'resend' || values.removeKey) {
    return null;
  }

  if (hasStoredKey && values.apiKey === STORED_API_KEY_SENTINEL) {
    return null;
  }

  if (values.apiKey.trim() === '') {
    return hasStoredKey
      ? 'Enter a new key or remove the stored key.'
      : 'Enter the Resend API key.';
  }

  // A partially deleted sentinel is not a key. Refuse it instead of sending
  // the mask characters to the provider.
  if (values.apiKey.startsWith('•')) {
    return 'Enter a new key, leave the stored key, or remove it.';
  }

  return null;
};

/**
 * Assembles the wire request from secret-free variables plus the key.
 */
export const toUpdateRequest = (
  variables: SaveSettingsVariables,
  apiKey: string,
  hasStoredKey: boolean,
): UpdateEmailSettingsRequest => {
  const credential: UpdateEmailSettingsRequest['credential'] =
    variables.removeKey && variables.provider === 'resend' && hasStoredKey
      ? { operation: 'remove' }
      : variables.provider !== 'resend' ||
          (hasStoredKey && variables.apiKeyUnchanged)
        ? { operation: 'keep' }
        : { operation: 'replace', value: apiKey.trim() };

  return {
    credential,
    expectedRevision: variables.expectedRevision,
    fromEmail: variables.fromEmail,
    fromName: variables.fromName,
    provider: variables.provider,
  };
};
