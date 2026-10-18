/**
 * Form-value translation for Manage -> Email. Kept separate from the React
 * component so the secret-free mutation contract is directly testable: React
 * Query mutation variables never contain the Resend API key, and the request
 * is assembled around a request-scoped secret reference.
 *
 * `provider` doubles as the sending method: `disabled` is the explicit Off
 * choice, so there is no separate installation enable flag.
 */

import { type UpdateEmailSettingsRequest } from '@/domain/schemas';

export type ManageEmailFormValues = {
  apiKey: string;
  credentialOperation: 'keep' | 'remove' | 'replace';
  fromEmail: string;
  fromName: string;
  provider: 'cloudflare' | 'disabled' | 'resend';
};

export type SaveSettingsVariables = {
  credentialOperation: 'keep' | 'remove' | 'replace';
  expectedRevision: number;
  fromEmail: null | string;
  fromName: null | string;
  provider: 'cloudflare' | 'disabled' | 'resend';
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
  apiKey: '',
  credentialOperation: settings.hasApiKey ? 'keep' : 'replace',
  fromEmail: settings.fromEmail ?? '',
  fromName: settings.fromName ?? '',
  provider: settings.provider,
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
  credentialOperation: values.credentialOperation,
  expectedRevision,
  fromEmail: trimmedOrNull(values.fromEmail),
  fromName: trimmedOrNull(values.fromName),
  provider: values.provider,
});

const credentialForRequest = (
  provider: 'cloudflare' | 'disabled' | 'resend',
  operation: 'keep' | 'remove' | 'replace',
  apiKey: string,
  hasApiKey: boolean,
): UpdateEmailSettingsRequest['credential'] => {
  if (provider !== 'resend') {
    return { operation: 'keep' };
  }

  if (hasApiKey && operation === 'keep') {
    return { operation: 'keep' };
  }

  if (hasApiKey && operation === 'remove') {
    return { operation: 'remove' };
  }

  return { operation: 'replace', value: apiKey.trim() };
};

/**
 * Assembles the wire request from secret-free variables plus the key.
 */
export const toUpdateRequest = (
  variables: SaveSettingsVariables,
  apiKey: string,
  hasApiKey: boolean,
): UpdateEmailSettingsRequest => ({
  credential: credentialForRequest(
    variables.provider,
    variables.credentialOperation,
    apiKey,
    hasApiKey,
  ),
  expectedRevision: variables.expectedRevision,
  fromEmail: variables.fromEmail,
  fromName: variables.fromName,
  provider: variables.provider,
});
