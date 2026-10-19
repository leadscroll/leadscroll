import { type EmailSettingsView } from '../api';
import { ChevronRight, Info } from 'lucide-react';

const DetailRow = ({
  children,
  label,
  mono = false,
}: {
  readonly children: React.ReactNode;
  readonly label: string;
  readonly mono?: boolean;
}) => (
  <div className="grid grid-cols-[150px_minmax(0,1fr)] gap-4 border-b border-slate-800 py-2.5 last:border-b-0">
    <dt className="pt-0.5 text-[11px] text-slate-500">{label}</dt>
    <dd
      className={
        mono
          ? 'break-all font-mono text-[11px] text-slate-400'
          : 'text-xs text-slate-300'
      }
    >
      {children}
    </dd>
  </div>
);

/**
 * Read-only deployment facts, kept out of the configuration rows. Only the
 * facts that belong to the selected method are listed.
 */
export const EnvironmentDetails = ({
  settings,
}: {
  readonly settings: EmailSettingsView;
}) => {
  const summary =
    settings.provider === 'cloudflare'
      ? `Cloudflare connection ${settings.environment.hasCloudflareBinding ? 'present' : 'missing'}`
      : settings.provider === 'resend'
        ? `Encryption key ${settings.environment.hasEncryptionKey ? 'configured' : 'missing'}`
        : 'Application URL set';

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3 text-xs text-slate-400 [&::-webkit-details-marker]:hidden">
          <Info
            aria-hidden="true"
            size={14}
          />
          <span>Environment</span>
          <span className="truncate text-slate-500">· {summary}</span>
          <ChevronRight
            aria-hidden="true"
            className="ml-auto shrink-0 transition-transform group-open:rotate-90"
            size={14}
          />
        </summary>
        <dl className="border-t border-slate-800 px-5 pb-1">
          {settings.provider === 'cloudflare' && (
            <DetailRow label="Cloudflare connection">
              {settings.environment.hasCloudflareBinding
                ? 'Present'
                : 'Not present'}
            </DetailRow>
          )}
          {settings.provider === 'resend' && (
            <DetailRow label="Encryption key">
              {settings.environment.hasEncryptionKey ? 'Configured' : 'Missing'}
            </DetailRow>
          )}
          <DetailRow
            label="Application URL"
            mono
          >
            {settings.canonicalOrigin}
          </DetailRow>
          <DetailRow label="Settings revision">
            {String(settings.revision)}
          </DetailRow>
        </dl>
      </details>
    </section>
  );
};
