import {
  type AccountPasswordFormValues,
  type AccountProfileFormValues,
  emptyAccountPasswordFormValues,
  toChangeAccountPasswordRequest,
  toUpdateAccountProfileRequest,
} from '@/account/accountFormValues';
import { describeAgent, formatTimestamp } from '@/account/sessionPresentation';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Notice } from '@/components/Notice';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Form } from '@/components/ui/Form';
import { inputClass } from '@/components/ui/form';
import {
  CURRENT_PASSWORD_MAX,
  PASSWORD_MAX,
  PASSWORD_MIN,
} from '@/domain/password-policy';
import { type AccountSessionView } from '@/domain/schemas';
import { changePassword, updateUser, useSession } from '@/lib/auth-client';
import { request } from '@/lib/http';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

const sessionQueryKey = (userId: string, sessionId: string) =>
  ['account-sessions', userId, sessionId] as const;

const ProfileSection = ({
  email,
  name,
  updatedAt,
}: {
  readonly email: string;
  readonly name: string;
  readonly updatedAt: Date;
}) => {
  const { refetch } = useSession();
  const queryClient = useQueryClient();
  const {
    formState: { errors, isDirty, isSubmitting },
    handleSubmit,
    register,
    reset,
  } = useForm<AccountProfileFormValues>({
    defaultValues: { name },
    mode: 'onTouched',
  });
  const submitLock = useRef(false);
  const releaseSubmit = () => {
    submitLock.current = false;
  };

  const newestRevision = useRef(updatedAt.getTime());
  const acceptedName = useRef<null | {
    name: string;
    previousRevision: number;
  }>(null);
  const [feedback, setFeedback] = useState('');
  useEffect(() => {
    const revision = updatedAt.getTime();
    if (
      revision < newestRevision.current ||
      (acceptedName.current !== null &&
        name !== acceptedName.current.name &&
        revision <= acceptedName.current.previousRevision)
    ) {
      return;
    }

    newestRevision.current = revision;
    acceptedName.current = null;
    if (!isDirty) {
      reset({ name });
    }
  }, [isDirty, name, reset, updatedAt]);

  const save = useMutation({
    mutationFn: async (input: AccountProfileFormValues) => {
      const { error } = await updateUser(input);
      if (error) {
        throw new Error(error.message ?? 'The name could not be saved.');
      }
    },
    onSuccess: async (_, input) => {
      acceptedName.current = {
        name: input.name,
        previousRevision: newestRevision.current,
      };
      reset(input);
      await Promise.all([
        refetch(),
        queryClient.invalidateQueries({ queryKey: ['staff'] }),
      ]);
      toast.success('Name updated');
    },
  });
  const pending = save.isPending || isSubmitting;
  return (
    <section className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/40 p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
        Profile
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        Your display name appears in the staff list. Activity history uses your
        email.
      </p>
      <Form
        className="mt-4 grid gap-4"
        onChange={() => setFeedback('')}
        onSubmit={(event) => {
          void handleSubmit(async (values) => {
            if (submitLock.current || pending) {
              return;
            }

            if (values.name.trim() === (acceptedName.current?.name ?? name)) {
              setFeedback('No changes to save.');
              return;
            }

            setFeedback('');

            submitLock.current = true;
            try {
              await save.mutateAsync(toUpdateAccountProfileRequest(values));
            } catch {
              /* Mutation error is displayed below. */
            } finally {
              releaseSubmit();
            }
          })(event);
        }}
      >
        <Field
          error={errors.name?.message}
          hint="1–200 characters"
          label="Name"
        >
          <input
            className={inputClass}
            disabled={pending}
            required
            {...register('name', {
              validate: (value) =>
                (value.trim().length > 0 && value.trim().length <= 200) ||
                'Enter a name of 1–200 characters.',
            })}
          />
        </Field>
        <Field
          hint="Email changes are unavailable on this installation. A replacement invited account does not transfer your history."
          label="Email"
        >
          <input
            className={`${inputClass} cursor-not-allowed opacity-60`}
            readOnly
            value={email}
          />
        </Field>
        {save.error && <Notice error={save.error} />}
        {feedback && (
          <p
            className="field-hint"
            role="status"
          >
            {feedback}
          </p>
        )}
        <div>
          <Button
            disabled={pending}
            type="submit"
          >
            {pending ? 'Saving…' : 'Save name'}
          </Button>
        </div>
      </Form>
    </section>
  );
};

const PasswordSection = () => {
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

const SessionsSection = ({
  sessionId,
  userId,
}: {
  readonly sessionId: string;
  readonly userId: string;
}) => {
  const queryKey = sessionQueryKey(userId, sessionId);
  const queryClient = useQueryClient();
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);
  const actionLock = useRef(false);
  const releaseAction = () => {
    actionLock.current = false;
  };

  const sessions = useQuery({
    enabled: Boolean(userId && sessionId),
    queryFn: ({ signal }) =>
      request<AccountSessionView[]>('/v1/account/sessions', { signal }),
    queryKey,
  });

  const revokeOne = useMutation({
    mutationFn: (id: string) =>
      request<undefined>(`/v1/account/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.success('Session revoked');
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const revokeOthers = useMutation({
    mutationFn: () =>
      request<{ revoked: number }>('/v1/account/sessions/revoke-others', {
        method: 'POST',
      }),
    onSuccess: async (result) => {
      toast.success(
        result.revoked === 1
          ? 'Signed out 1 other device'
          : `Signed out ${result.revoked} other devices`,
      );
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const pending = revokeOne.isPending || revokeOthers.isPending;
  const rows = sessions.data ?? [];
  const otherCount = rows.filter((row) => !row.current).length;

  return (
    <section className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/40 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
          Sessions
        </h2>
        {otherCount > 0 && (
          <Button
            disabled={pending}
            onClick={() => {
              setConfirmRevokeAll(true);
            }}
            tone="secondary"
          >
            Sign out other devices ({otherCount})
          </Button>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Devices currently signed in to this account.
      </p>
      {sessions.isPending ? (
        <p className="mt-4 text-sm text-slate-400">Loading sessions…</p>
      ) : sessions.error ? (
        <div className="mt-4">
          <Notice error={sessions.error} />
        </div>
      ) : rows.length === 0 ? (
        <p className="mt-4 text-sm text-slate-400">No active sessions.</p>
      ) : (
        <ul className="mt-4 grid grid-cols-1 gap-2">
          {rows.map((row) => (
            <li
              className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/60 px-4 py-3"
              key={row.id}
            >
              <div className="min-w-0 max-w-full flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-100">
                  {describeAgent(row.userAgent)}
                  {row.current && (
                    <span className="rounded bg-cyan-400/15 px-1.5 py-0.5 text-xs font-semibold text-cyan-300">
                      This device
                    </span>
                  )}
                </p>
                <p className="mt-0.5 truncate text-xs text-slate-500">
                  {row.ipAddress ?? 'unknown IP'} · signed in{' '}
                  {formatTimestamp(row.createdAt)} · expires{' '}
                  {formatTimestamp(row.expiresAt)}
                </p>
              </div>
              {!row.current && (
                <Button
                  disabled={pending}
                  onClick={async () => {
                    if (actionLock.current) {
                      return;
                    }

                    actionLock.current = true;
                    try {
                      await revokeOne.mutateAsync(row.id);
                    } catch {
                      /* Error is displayed below. */
                    } finally {
                      releaseAction();
                    }
                  }}
                  tone="secondary"
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {revokeOne.error && (
        <div className="mt-4">
          <Notice error={revokeOne.error} />
        </div>
      )}
      {revokeOthers.error && (
        <div className="mt-4">
          <Notice error={revokeOthers.error} />
        </div>
      )}
      <ConfirmDialog
        confirmLabel="Sign out"
        description={`Sign out ${otherCount} ${
          otherCount === 1 ? 'device' : 'devices'
        }? They will need the password to sign in again.`}
        onConfirm={async () => {
          if (actionLock.current) {
            return;
          }

          actionLock.current = true;
          try {
            await revokeOthers.mutateAsync();
            setConfirmRevokeAll(false);
          } catch {
            /* Error is displayed below. */
          } finally {
            releaseAction();
          }
        }}
        onOpenChange={setConfirmRevokeAll}
        open={confirmRevokeAll}
        pending={pending}
        pendingLabel="Signing out…"
        title="Sign out other devices"
      />
    </section>
  );
};

export const AccountPage = () => {
  const { data: session, isPending } = useSession();
  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Account"
      />
      {isPending || !session ? (
        <p className="p-5 text-slate-400">Loading account…</p>
      ) : (
        <div
          className="grid grid-cols-1 gap-6 p-5 sm:p-8"
          key={session.user.id}
        >
          <ProfileSection
            email={session.user.email}
            name={session.user.name}
            updatedAt={new Date(session.user.updatedAt)}
          />
          <PasswordSection />
          <SessionsSection
            key={session.session.id}
            sessionId={session.session.id}
            userId={session.user.id}
          />
        </div>
      )}
    </>
  );
};
