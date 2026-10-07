import { localDateTimeToIso } from './datetime';
import { type CreateTokenRequest } from '@/domain/schemas';

export type TokenExpirationMode = '7' | '30' | '90' | 'custom' | 'never';

export type TokenFormValues = {
  expiration: string;
  expirationMode: TokenExpirationMode;
  name: string;
  type: 'api' | 'browser';
};

export const emptyTokenFormValues = (
  defaultExpiration: string,
): TokenFormValues => ({
  expiration: defaultExpiration,
  expirationMode: '90',
  name: '',
  type: 'api',
});

// Presets are elapsed 24-hour days from the selection time. Use the same
// reference for the displayed date and request so they cannot drift apart.
export const tokenExpiration = (
  values: Pick<TokenFormValues, 'expiration' | 'expirationMode'>,
  referenceTime: number,
): null | string | undefined => {
  if (values.expirationMode === 'never') {
    return null;
  }

  if (values.expirationMode === 'custom') {
    return localDateTimeToIso(values.expiration);
  }

  return new Date(
    referenceTime + Number(values.expirationMode) * 86_400_000,
  ).toISOString();
};

export const toCreateTokenRequest = (
  values: TokenFormValues,
  referenceTime = Date.now(),
): CreateTokenRequest => ({
  expiresAt: tokenExpiration(values, referenceTime),
  name: values.name.trim(),
  type: values.type,
});
