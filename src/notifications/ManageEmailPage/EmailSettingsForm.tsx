import {
  emailSettingsQueryKey,
  type EmailSettingsView,
  type EmailTestView,
  notificationsApi,
  savedConfigurationTestable,
} from '../api';
import { EmailStatusPanel } from './EmailStatusPanel';
import {
  type ManageEmailFormValues,
  toFormValues,
  toSaveVariables,
  toUpdateRequest,
} from './saveVariables';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Form } from '@/components/ui/Form';
import { inputClass } from '@/components/ui/form';
import { ApiClientError } from '@/lib/http';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

export const EmailSettingsForm = ({
  settings,
  userId,
}: {
  readonly settings: EmailSettingsView;
  readonly userId: string;
}) => {
  const queryClient = useQueryClient();
  const {
    formState: { errors, isDirty, isSubmitting },
    handleSubmit,
    register,
    reset,
    setError,
    watch,
  } = useForm<ManageEmailFormValues>({
    defaultValues: toFormValues(settings),
    mode: 'onTouched',
  });
  const provider = watch('provider');
  const credentialOperation = watch('credentialOperation');
  const submitLock = useRef(false);
  const releaseSubmit = () => {
    submitLock.current = false;
  };

  // The key lives only here, is consumed at the request boundary, and never
  // enters React Query variables, data, or error objects.
  const apiKeyReference = useRef('');
  const [testResult, setTestResult] = useState<EmailTestView | null>(null);
  const [conflict, setConflict] = useState(false);
  // The revision the draft is based on. It only advances on a successful save
  // or an explicit reload, so a background refetch can never silently rebase a
  // draft onto another administrator's changes.
  const baseRevision = useRef(settings.revision);

  useEffect(
    () => () => {
      apiKeyReference.current = '';
    },
    [],
  );

  useEffect(() => {
    if (isDirty) {
      return;
    }

    baseRevision.current = settings.revision;
    reset(toFormValues(settings));
  }, [isDirty, reset, settings]);

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

      void queryClient.invalidateQueries({
        queryKey: emailSettingsQueryKey(userId),
      });
    },
    onSuccess: (view) => {
      queryClient.setQueryData(emailSettingsQueryKey(userId), view);
      baseRevision.current = view.revision;
      setConflict(false);
      setTestResult(null);
      reset(toFormValues(view));
      toast.success('Email settings saved');
    },
  });

  const sendTest = useMutation({
    mutationFn: () =>
      notificationsApi.sendTest(settings.revision, crypto.randomUUID()),
    onSuccess: (view) => {
      setTestResult(view);
      void queryClient.invalidateQueries({
        queryKey: emailSettingsQueryKey(userId),
      });
      toast.success('Test email request completed');
    },
  });

  const pending = save.isPending || sendTest.isPending || isSubmitting;
  const submit = handleSubmit(async (values) => {
    if (submitLock.current) {
      return;
    }

    if (values.provider !== 'disabled' && values.fromEmail.trim() === '') {
      setError('fromEmail', { message: 'Enter the sender address.' });
      return;
    }

    if (
      values.provider === 'resend' &&
      (values.credentialOperation === 'replace' || !settings.hasApiKey) &&
      values.apiKey.trim() === ''
    ) {
      setError('apiKey', { message: 'Enter the Resend API key.' });
      return;
    }

    submitLock.current = true;
    apiKeyReference.current = values.apiKey;
    try {
      await save.mutateAsync(toSaveVariables(values, baseRevision.current));
    } catch {
      /* The mutation error is rendered below. */
    } finally {
      releaseSubmit();
    }
  });

  const testable = savedConfigurationTestable(settings);
  const testDisabled = !testable.ok || pending;
  const showsKeyField =
    provider === 'resend' &&
    (!settings.hasApiKey || credentialOperation === 'replace');
  const credentialNote =
    provider === 'resend'
      ? settings.hasApiKey
        ? 'A key is stored. Keep it, replace it, or remove it. The stored value is never shown again.'
        : 'Enter the send-only Resend API key. It is encrypted before storage and never returned to the browser.'
      : null;
  const externalChange = settings.revision !== baseRevision.current;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Form
        className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/40 p-5"
        onChange={() => {
          sendTest.reset();
        }}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
          Installation email
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Provider choice is installation-wide. Staff opt in to their own alerts
          under Account.
        </p>
        <div className="mt-4 grid gap-4">
          <label className="flex items-start gap-3 text-sm text-slate-200">
            <input
              className="mt-0.5"
              disabled={pending}
              type="checkbox"
              {...register('enabled')}
            />
            <span>
              <span className="font-medium">Enable new-lead emails</span>
              <span className="mt-0.5 block text-xs text-slate-500">
                Off stops new alerts and pauses anything waiting to send.
              </span>
            </span>
          </label>

          <Field
            error={errors.provider?.message}
            label="Provider"
          >
            <select
              className={inputClass}
              disabled={pending}
              {...register('provider')}
            >
              <option value="disabled">Disabled</option>
              <option value="cloudflare">Cloudflare Email Sending</option>
              <option value="resend">Resend</option>
            </select>
          </Field>

          {provider === 'cloudflare' && (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
              Cloudflare email sending requires a Workers Paid plan. We
              recommend sending a test email to confirm your setup.
            </p>
          )}

          {provider !== 'disabled' && (
            <>
              <Field
                error={errors.fromEmail?.message}
                hint="The address notifications are sent from. It must be verified at the provider."
                label="Sender address"
              >
                <input
                  autoComplete="off"
                  className={inputClass}
                  disabled={pending}
                  placeholder="notifications@example.com"
                  type="email"
                  {...register('fromEmail')}
                />
              </Field>
              <Field
                error={errors.fromName?.message}
                hint="Optional display name, 1–120 characters"
                label="Sender name"
              >
                <input
                  autoComplete="off"
                  className={inputClass}
                  disabled={pending}
                  placeholder="LeadScroll"
                  {...register('fromName')}
                />
              </Field>
            </>
          )}

          {provider === 'resend' && (
            <div className="grid gap-3">
              {settings.hasApiKey && (
                <fieldset
                  className="grid gap-2 text-sm text-slate-200"
                  disabled={pending}
                >
                  <legend className="field-label">Resend API key</legend>
                  {(
                    [
                      ['keep', 'Keep the stored key'],
                      ['replace', 'Replace the stored key'],
                      ['remove', 'Remove the stored key and disable Resend'],
                    ] as const
                  ).map(([value, label]) => (
                    <label
                      className="flex items-center gap-2"
                      key={value}
                    >
                      <input
                        type="radio"
                        value={value}
                        {...register('credentialOperation')}
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
              )}
              {showsKeyField && (
                <Field
                  error={errors.apiKey?.message}
                  hint="Write-only: it is never redisplayed, cached, or stored in the browser."
                  label="Resend API key"
                >
                  <input
                    autoComplete="new-password"
                    className={inputClass}
                    disabled={pending}
                    placeholder="re_…"
                    type="password"
                    {...register('apiKey')}
                  />
                </Field>
              )}
              {credentialNote !== null && (
                <p className="text-xs text-slate-500">{credentialNote}</p>
              )}
            </div>
          )}

          <Field
            hint="Read-only canonical URL used in notification links."
            label="Application URL"
          >
            <input
              className={`${inputClass} cursor-not-allowed opacity-60`}
              readOnly
              value={settings.canonicalOrigin}
            />
          </Field>

          {(conflict || externalChange) && (
            <div
              className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100"
              role="alert"
            >
              <p>
                Email settings changed in another session. Saving may conflict;
                reloading replaces your draft with the latest saved settings.
              </p>
              <Button
                className="mt-2"
                onClick={() => {
                  baseRevision.current = settings.revision;
                  setConflict(false);
                  reset(toFormValues(settings));
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
              {save.isPending ? 'Saving…' : 'Save settings'}
            </Button>
            {isDirty && (
              <span className="text-xs text-slate-500">Unsaved changes</span>
            )}
          </div>
        </div>
      </Form>

      <EmailStatusPanel
        error={sendTest.error ?? (conflict ? null : save.error)}
        onSendTest={() => sendTest.mutate()}
        pending={sendTest.isPending}
        sendTestDisabled={testDisabled}
        sendTestDisabledReason={testable.ok ? null : testable.message}
        settings={settings}
        testResult={testResult}
      />
    </div>
  );
};
