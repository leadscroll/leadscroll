import { type EmailSettingsView } from '../api';
import { PROVIDER_LABELS, readinessReasonLabel } from './labels';

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

export const ReadValues = ({
  settings,
}: {
  readonly settings: EmailSettingsView;
}) => (
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
