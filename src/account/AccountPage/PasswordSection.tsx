import {
  type AccountPasswordFormValues,
  emptyAccountPasswordFormValues,
  toChangeAccountPasswordRequest,
} from '@/account/accountFormValues';
import { Notice } from '@/components/Notice';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Form } from '@/components/ui/Form';
import { inputClass } from '@/components/ui/form';
import {
  CURRENT_PASSWORD_MAX,
  PASSWORD_MAX,
  PASSWORD_MIN,
} from '@/domain/password-policy';
import { changePassword, useSession } from '@/lib/auth-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

export const PasswordSection = () => {
  const submitLock = useRef(false);
  const releaseSubmit = () => {
    submitLock.current = false;
  };

  const { refetch } = useSession();
  const queryClient = useQueryClient();
  const {
    formState: { errors, isSubmitting },
    getValues,
    handleSubmit,
    register,
    reset,
  } = useForm<AccountPasswordFormValues>({
    defaultValues: emptyAccountPasswordFormValues,
    mode: 'onTouched',
  });
  useEffect(() => () => reset(emptyAccountPasswordFormValues), [reset]);
  const rotate = useMutation({
    gcTime: 0,
    // No credential payload is passed as mutation variables or cached data.
    mutationFn: async () => {
      const { error } = await changePassword(
        toChangeAccountPasswordRequest(getValues()),
      );
      if (error) {
        throw new Error(error.message ?? 'The password could not be changed.');
      }
    },
    onSuccess: async () => {
      reset(emptyAccountPasswordFormValues);
      await refetch();
      await queryClient.invalidateQueries({ queryKey: ['account-sessions'] });
      toast.success('Password changed');
      toast.info('Other devices were signed out');
    },
  });
  const pending = rotate.isPending || isSubmitting;
  return (
    <section className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/40 p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
        Password
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        Changing the password signs out every other device.
      </p>
      <Form
        className="mt-4 grid gap-4"
        onSubmit={(event) => {
          void handleSubmit(async () => {
            if (submitLock.current || pending) {
              return;
            }

            submitLock.current = true;
            try {
              await rotate.mutateAsync();
            } catch {
              /* Mutation error is displayed below. */
            } finally {
              releaseSubmit();
            }
          })(event);
        }}
      >
        <Field
          error={errors.currentPassword?.message}
          label="Current password"
        >
          <input
            autoComplete="current-password"
            className={inputClass}
            disabled={pending}
            maxLength={CURRENT_PASSWORD_MAX}
            required
            type="password"
            {...register('currentPassword', {
              required: 'Enter your current password.',
            })}
          />
        </Field>
        <Field
          error={errors.newPassword?.message}
          hint="8–255 characters; cannot be only whitespace."
          label="New password"
        >
          <input
            autoComplete="new-password"
            className={inputClass}
            disabled={pending}
            maxLength={PASSWORD_MAX}
            minLength={PASSWORD_MIN}
            required
            type="password"
            {...register('newPassword', {
              deps: ['confirmation'],
              validate: (value) =>
                (value.length >= PASSWORD_MIN &&
                  value.length <= PASSWORD_MAX &&
                  value.trim().length > 0) ||
                'Enter a password of 8–255 characters that is not only whitespace.',
            })}
          />
        </Field>
        <Field
          error={errors.confirmation?.message}
          label="Confirm new password"
        >
          <input
            autoComplete="new-password"
            className={inputClass}
            disabled={pending}
            maxLength={PASSWORD_MAX}
            required
            type="password"
            {...register('confirmation', {
              validate: (value) =>
                value === getValues('newPassword') ||
                'The new passwords do not match.',
            })}
          />
        </Field>
        {rotate.error && <Notice error={rotate.error} />}
        <div>
          <Button
            disabled={pending}
            type="submit"
          >
            {pending ? 'Changing…' : 'Change password'}
          </Button>
        </div>
      </Form>
    </section>
  );
};
