import { type EmailSettingsView, type EmailTestView } from '../api';
import {
  pausedReasonLabel,
  readinessReasonLabel,
  testOutcomeLabel,
} from './labels';
import { Notice } from '@/components/Notice';
import { Button } from '@/components/ui/Button';

const availabilityTone = {
  configured: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100',
  disabled: 'border-slate-700 bg-slate-900/60 text-slate-300',
  misconfigured: 'border-amber-500/30 bg-amber-500/10 text-amber-100',
  unavailable: 'border-rose-500/30 bg-rose-500/10 text-rose-100',
} as const;

const availabilityTitle = {
  configured: 'Configured locally',
  disabled: 'Email sending is disabled',
  misconfigured: 'Configuration is incomplete',
  unavailable: 'Sending is paused',
} as const;

const formatTimestamp = (value: null | string): string =>
  value === null ? '—' : new Date(value).toLocaleString();

export const EmailStatusPanel = ({
  error,
  onSendTest,
  pending,
  sendTestDisabled,
  settings,
  testResult,
}: {
  readonly error: unknown;
  readonly onSendTest: () => void;
  readonly pending: boolean;
  readonly sendTestDisabled: boolean;
  readonly settings: EmailSettingsView;
  readonly testResult: EmailTestView | null;
}) => {
  const availability = settings.readiness.availability;
  const currentTest =
    testResult ??
    (settings.test !== null && settings.test.revision === settings.revision
      ? settings.test
      : null);
  const notTested =
    settings.test === null || settings.test.revision !== settings.revision;
  return (
    <section className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/40 p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
        Setup status
      </h2>
      <div
        className={`mt-3 rounded-lg border p-3 text-sm ${availabilityTone[availability]}`}
      >
        <p className="font-medium">{availabilityTitle[availability]}</p>
        {availability === 'misconfigured' && (
          <p className="mt-1">
            {readinessReasonLabel(settings.readiness.reasonCode) ??
              'Complete the saved provider configuration.'}
          </p>
        )}
        {availability === 'unavailable' && settings.paused && (
          <p className="mt-1">
            {pausedReasonLabel(settings.paused.reasonCode)} Changing the
            settings or a successful test resumes sending.
          </p>
        )}
        {availability === 'configured' && (
          <p className="mt-1">
            Local configuration checks passed. A test email confirms the
            provider accepts messages; local checks cannot prove remote
            readiness.
          </p>
        )}
      </div>

      <dl className="mt-4 grid gap-2 text-sm">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-slate-400">Cloudflare EMAIL binding</dt>
          <dd className="text-slate-200">
            {settings.environment.hasCloudflareBinding
              ? 'Present'
              : 'Not present'}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-slate-400">Encryption key</dt>
          <dd className="text-slate-200">
            {settings.environment.hasEncryptionKey ? 'Configured' : 'Missing'}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-slate-400">Resend key</dt>
          <dd className="text-slate-200">
            {settings.hasApiKey ? 'Stored' : 'Not stored'}
          </dd>
        </div>
      </dl>

      <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-200">
              {notTested && currentTest === null
                ? 'Not tested'
                : testOutcomeLabel(
                    currentTest?.outcome ?? settings.test?.outcome ?? 'sending',
                  )}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              {currentTest === null
                ? 'No test has been sent for the current revision. Testing is recommended, never required.'
                : `Last test ${formatTimestamp(currentTest.at)}${
                    currentTest.revision === settings.revision
                      ? ''
                      : ' (earlier revision)'
                  }`}
            </p>
          </div>
          <Button
            disabled={pending || sendTestDisabled}
            onClick={onSendTest}
            tone="secondary"
          >
            {pending ? 'Sending…' : 'Send test email'}
          </Button>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          The test goes only to your own account email using the saved
          configuration. Saving or enabling never sends automatically.
        </p>
      </div>

      {error !== null && error !== undefined && (
        <div className="mt-4">
          <Notice error={error} />
        </div>
      )}
    </section>
  );
};
