import {
  emailSettingsQueryKey,
  type EmailSettingsView,
  type EmailTestView,
  notificationsApi,
} from '../api';
import { EnvironmentDetails } from './EnvironmentDetails';
import { PROVIDER_LABELS, readinessReasonLabel } from './labels';
import { MethodPicker } from './MethodPicker';
import {
  apiKeyValidationError,
  type ManageEmailFormValues,
  STORED_API_KEY_SENTINEL,
  toFormValues,
  toSaveVariables,
  toUpdateRequest,
} from './saveVariables';
import { SetupCheck } from './SetupCheck';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Form } from '@/components/ui/Form';
import { inputClass } from '@/components/ui/form';
import { type NotificationAvailability } from '@/domain/schemas';
import { ApiClientError } from '@/lib/http';
import { cn } from '@/lib/styles';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useForm, type UseFormRegister } from 'react-hook-form';
import { toast } from 'sonner';

const ValueRow = ({
  children,
  label,
}: {
  readonly children: React.ReactNode;
  readonly label: string;
}) => (
  <div className="grid grid-cols-[130px_minmax(0,1fr)] gap-4 border-b border-slate-800 py-3 last:border-b-0">
    <dt className="pt-0.5 text-xs text-slate-500">{label}</dt>
    <dd className="min-w-0 text-sm text-slate-200">{children}</dd>
  </div>
);

export const EmailAvailabilityChip = ({
  availability,
}: {
  readonly availability: NotificationAvailability;
}) => {
  const state =
    availability === 'configured'
      ? { dot: 'bg-emerald-400', label: 'Configured', tone: 'text-emerald-200' }
      : availability === 'misconfigured'
        ? { dot: 'bg-amber-400', label: 'Incomplete', tone: 'text-amber-200' }
        : { dot: 'bg-slate-500', label: 'Off', tone: 'text-slate-400' };

  return (
    <span className={cn('inline-flex items-center gap-2 text-xs', state.tone)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', state.dot)} />
      {state.label}
    </span>
  );
};

const ReadValues = ({ settings }: { readonly settings: EmailSettingsView }) => (
  <dl className="px-5 pb-1">
    <ValueRow label="Method">
      {PROVIDER_LABELS[settings.provider]}
      {settings.provider === 'disabled' && (
        <span className="mt-1 block text-xs text-slate-500">
          No lead email is sent. Staff preferences are kept.
        </span>
      )}
      {settings.provider !== 'disabled' &&
        settings.readiness.availability === 'misconfigured' && (
          <span className="mt-1 block text-xs text-amber-200">
            {readinessReasonLabel(settings.readiness.reasonCode) ??
              'Complete the saved method.'}
          </span>
        )}
    </ValueRow>
    {settings.provider !== 'disabled' && (
      <>
        <ValueRow label="From name">{settings.fromName ?? 'Not set'}</ValueRow>
        <ValueRow label="From address">
          {settings.fromEmail ?? 'Not set'}
        </ValueRow>
        {settings.provider === 'resend' && (
          <ValueRow label="API key">
            {settings.hasApiKey ? 'Stored' : 'Not stored'}
          </ValueRow>
        )}
      </>
    )}
  </dl>
);

const selectStoredKey = (
  event:
    React.FocusEvent<HTMLInputElement> | React.MouseEvent<HTMLInputElement>,
) => {
  if (event.currentTarget.value === STORED_API_KEY_SENTINEL) {
    event.currentTarget.select();
  }
};

const ResendKeyFields = ({
  apiKeyError,
  hasStoredKey,
  pending,
  register,
  removeKey,
}: {
  readonly apiKeyError?: string;
  readonly hasStoredKey: boolean;
  readonly pending: boolean;
  readonly register: UseFormRegister<ManageEmailFormValues>;
  readonly removeKey: boolean;
}) => (
  <div className="grid max-w-md gap-3">
    <Field
      error={apiKeyError}
      hint={
        hasStoredKey
          ? 'A key is stored. Leave the masked value unchanged to keep it, or type a new key to replace it.'
          : 'Write-only: it is never redisplayed, cached, or stored in the browser.'
      }
      label="Resend API key"
    >
      <input
        autoComplete="new-password"
        className={inputClass}
        disabled={pending || removeKey}
        onClick={selectStoredKey}
        onFocus={selectStoredKey}
        placeholder={hasStoredKey ? undefined : 're_…'}
        type="password"
        {...register('apiKey')}
      />
    </Field>
    {hasStoredKey && (
      <label className="flex items-start gap-2 text-xs text-slate-400">
        <input
          className="mt-0.5"
          disabled={pending}
          type="checkbox"
          {...register('removeKey')}
        />
        <span>
          Remove the stored key. Saving switches sending to Off and keeps the
          sender details.
        </span>
      </label>
    )}
    {removeKey && (
      <p className="text-xs text-rose-200">
        The key will be removed and sending will switch to Off when you save.
      </p>
    )}
  </div>
);

export const EmailSettingsPanel = ({
  accountEmail,
  settings,
  userId,
}: {
  readonly accountEmail: string;
  readonly settings: EmailSettingsView;
  readonly userId: string;
}) => {
  const queryClient = useQueryClient();
  const queryKey = emailSettingsQueryKey(userId);
  const [editing, setEditing] = useState(false);
  const [testResult, setTestResult] = useState<EmailTestView | null>(null);
  const [conflict, setConflict] = useState(false);
  // The key lives only here, is consumed at the request boundary, and never
  // enters React Query variables, data, or error objects.
  const apiKeyReference = useRef('');
  const submitLock = useRef(false);
  // The revision the draft is based on. It only advances on a successful save
  // or an explicit reload, so a background refetch can never silently rebase a
  // draft onto another staff member's changes.
  const baseRevision = useRef(settings.revision);

  const {
    clearErrors,
    formState: { errors, isDirty, isSubmitting },
    handleSubmit,
    register,
    reset,
    setError,
    setValue,
    watch,
  } = useForm<ManageEmailFormValues>({
    defaultValues: toFormValues(settings),
    mode: 'onTouched',
  });
  const provider = watch('provider');
  const removeKey = watch('removeKey');

  useEffect(
    () => () => {
      apiKeyReference.current = '';
    },
    [],
  );

  // While reading, keep the form in sync with the saved document. While
  // editing, the draft is preserved until save, cancel, or an explicit reload.
  useEffect(() => {
    if (editing) {
      return;
    }

    baseRevision.current = settings.revision;
    reset(toFormValues(settings));
  }, [editing, reset, settings]);

  // Removal is meaningful only while Resend is selected. Clearing it on a
  // method change avoids a hidden destructive action if the user switches back.
  useEffect(() => {
    if (provider !== 'resend') {
      setValue('removeKey', false);
    }
  }, [provider, setValue]);

  const save = useMutation({
    mutationFn: (variables: ReturnType<typeof toSaveVariables>) => {
      const apiKey = apiKeyReference.current;
      apiKeyReference.current = '';
      return notificationsApi.saveSettings(
        toUpdateRequest(variables, apiKey, settings.hasApiKey),
      );
    },
    onError: (error) => {
      if (error instanceof ApiClientError && error.status === 409) {
        setConflict(true);
      }

      void queryClient.invalidateQueries({ queryKey });
    },
    onSuccess: (view) => {
      queryClient.setQueryData(queryKey, view);
      baseRevision.current = view.revision;
      setConflict(false);
      setTestResult(null);
      setEditing(false);
      reset(toFormValues(view));
      toast.success('Email settings saved');
    },
  });

  const sendTest = useMutation({
    mutationFn: () =>
      notificationsApi.sendTest(settings.revision, crypto.randomUUID()),
    onSuccess: (view) => {
      setTestResult(view);
      void queryClient.invalidateQueries({ queryKey });
      toast.success('Test email request completed');
    },
  });

  const pending = save.isPending || sendTest.isPending || isSubmitting;
  const externalChange = editing && settings.revision !== baseRevision.current;
  const hasStoredKey = settings.hasApiKey;
  const cloudflareTested =
    settings.provider === 'cloudflare' &&
    settings.test?.revision === settings.revision &&
    settings.test.outcome === 'accepted';

  const releaseSubmit = () => {
    submitLock.current = false;
  };

  const startEditing = () => {
    baseRevision.current = settings.revision;
    reset(toFormValues(settings));
    save.reset();
    sendTest.reset();
    setConflict(false);
    setEditing(true);
  };

  const cancelEditing = () => {
    baseRevision.current = settings.revision;
    reset(toFormValues(settings));
    save.reset();
    sendTest.reset();
    setConflict(false);
    setEditing(false);
  };

  const reloadLatest = async () => {
    try {
      const latest = await queryClient.fetchQuery({
        queryFn: () => notificationsApi.getSettings(),
        queryKey,
      });
      baseRevision.current = latest.revision;
      reset(toFormValues(latest));
      save.reset();
      sendTest.reset();
      setConflict(false);
      setTestResult(null);
    } catch {
      toast.error('Could not reload the latest settings.');
    }
  };

  const submit = handleSubmit(async (values) => {
    if (submitLock.current) {
      return;
    }

    if (values.provider !== 'disabled' && values.fromEmail.trim() === '') {
      setError('fromEmail', { message: 'Enter the sender address.' });
      return;
    }

    const keyError = apiKeyValidationError(values, hasStoredKey);
    if (keyError !== null) {
      setError('apiKey', { message: keyError });
      return;
    }

    submitLock.current = true;
    apiKeyReference.current =
      values.apiKey === STORED_API_KEY_SENTINEL ? '' : values.apiKey;
    try {
      await save.mutateAsync(toSaveVariables(values, baseRevision.current));
    } catch {
      /* The mutation error is rendered below. */
    } finally {
      releaseSubmit();
    }
  });

  return (
    <div className="grid max-w-3xl gap-3.5">
      <section className="rounded-xl border border-slate-800 bg-slate-900/40">
        <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-5 py-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Sending
          </h2>
          {editing ? (
            <span className="text-xs text-amber-200">
              {isDirty ? 'Unsaved changes' : 'Editing'}
            </span>
          ) : (
            <Button
              disabled={pending}
              onClick={startEditing}
              tone="ghost"
            >
              Edit
            </Button>
          )}
        </div>

        {editing ? (
          <Form
            className="px-5 py-4"
            onChange={() => {
              clearErrors('apiKey');
              sendTest.reset();
            }}
            onSubmit={(event) => {
              void submit(event);
            }}
          >
            <div className="grid gap-4">
              <MethodPicker
                register={register}
                value={provider}
              />

              {provider === 'cloudflare' && !cloudflareTested && (
                <p className="text-xs text-amber-200/90">
                  Cloudflare Email Sending requires a Workers Paid plan and a
                  sender domain verified in Cloudflare.
                </p>
              )}

              {provider !== 'disabled' && (
                <div className="grid max-w-md gap-4">
                  <Field
                    error={errors.fromName?.message}
                    hint="Optional display name, 1–120 characters"
                    label="From name"
                  >
                    <input
                      autoComplete="off"
                      className={inputClass}
                      disabled={pending}
                      placeholder="LeadScroll"
                      {...register('fromName')}
                    />
                  </Field>
                  <Field
                    error={errors.fromEmail?.message}
                    hint="Must be verified at the provider."
                    label="From address"
                  >
                    <input
                      autoComplete="off"
                      className={inputClass}
                      disabled={pending}
                      placeholder="notifications@example.com"
                      required
                      type="email"
                      {...register('fromEmail')}
                    />
                  </Field>
                </div>
              )}

              {provider === 'resend' && (
                <ResendKeyFields
                  apiKeyError={errors.apiKey?.message}
                  hasStoredKey={hasStoredKey}
                  pending={pending}
                  register={register}
                  removeKey={removeKey}
                />
              )}

              {(conflict || externalChange) && (
                <div
                  className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100"
                  role="alert"
                >
                  <p>
                    Email settings changed in another session. Reloading
                    replaces your draft with the latest saved settings.
                  </p>
                  <Button
                    className="mt-2"
                    onClick={() => {
                      void reloadLatest();
                    }}
                    tone="secondary"
                    type="button"
                  >
                    Reload latest settings
                  </Button>
                </div>
              )}

              {save.error && !conflict && (
                <p
                  className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-100"
                  role="alert"
                >
                  {save.error instanceof Error
                    ? save.error.message
                    : 'The settings could not be saved.'}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  disabled={pending}
                  type="submit"
                >
                  {save.isPending ? 'Saving…' : 'Save changes'}
                </Button>
                <Button
                  disabled={pending}
                  onClick={cancelEditing}
                  tone="ghost"
                  type="button"
                >
                  Cancel
                </Button>
              </div>
            </div>
          </Form>
        ) : (
          <ReadValues settings={settings} />
        )}
      </section>

      <SetupCheck
        accountEmail={accountEmail}
        editing={editing}
        onSendTest={() => sendTest.mutate()}
        pending={sendTest.isPending}
        settings={settings}
        testResult={testResult}
      />

      <EnvironmentDetails settings={settings} />
    </div>
  );
};
