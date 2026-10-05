import { localDateTimeToIso } from './datetime';
import { type CreateInviteRequest } from '@/domain/schemas';

export type InviteFormValues = {
  expiration: string;
  name: string;
};

export const emptyInviteFormValues = (
  defaultExpiration: string,
): InviteFormValues => ({
  expiration: defaultExpiration,
  name: '',
});

export const toCreateInviteRequest = (
  values: InviteFormValues,
): CreateInviteRequest => ({
  expiresAt: localDateTimeToIso(values.expiration),
  name: values.name.trim(),
});
