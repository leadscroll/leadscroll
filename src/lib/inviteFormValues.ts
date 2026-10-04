import { localDateTimeToIso } from './datetime';
import { type CreateInviteInput } from '@/domain/schemas';

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

export const toCreateInviteInput = (
  values: InviteFormValues,
): CreateInviteInput => ({
  expiresAt: localDateTimeToIso(values.expiration),
  name: values.name.trim(),
});
