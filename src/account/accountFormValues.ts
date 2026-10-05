import {
  type ChangeAccountPasswordRequest,
  type UpdateAccountProfileRequest,
} from '@/domain/schemas';

export type AccountPasswordFormValues = ChangeAccountPasswordRequest & {
  confirmation: string;
};
export type AccountProfileFormValues = { name: string };
export const emptyAccountPasswordFormValues: AccountPasswordFormValues = {
  confirmation: '',
  currentPassword: '',
  newPassword: '',
};
export const toUpdateAccountProfileRequest = (
  values: AccountProfileFormValues,
): UpdateAccountProfileRequest => ({ name: values.name.trim() });
export const toChangeAccountPasswordRequest = (
  values: AccountPasswordFormValues,
): ChangeAccountPasswordRequest => ({
  currentPassword: values.currentPassword,
  newPassword: values.newPassword,
});
