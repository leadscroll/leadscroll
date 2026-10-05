import { localDateTimeToIso } from './datetime';
import { type CreateTokenRequest } from '@/domain/schemas';

export type TokenFormValues = {
  expiration: string;
  name: string;
  neverExpires: boolean;
  type: 'api' | 'browser';
};

export const emptyTokenFormValues = (
  defaultExpiration: string,
): TokenFormValues => ({
  expiration: defaultExpiration,
  name: '',
  neverExpires: false,
  type: 'api',
});

export const toCreateTokenRequest = (
  values: TokenFormValues,
): CreateTokenRequest => ({
  expiresAt: values.neverExpires ? null : localDateTimeToIso(values.expiration),
  name: values.name.trim(),
  type: values.type,
});
