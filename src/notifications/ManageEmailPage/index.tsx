import { emailSettingsQueryKey, notificationsApi } from '../api';
import { EmailSettingsForm } from './EmailSettingsForm';
import { PageHeader } from '@/components/PageHeader';
import { ApiClientError } from '@/lib/http';
import { useQuery } from '@tanstack/react-query';

const OwnerRequired = ({ message }: { readonly message: string }) => (
  <div className="max-w-2xl rounded-xl border border-amber-500/30 bg-amber-500/10 p-5 text-sm text-amber-100">
    <h2 className="font-semibold">Email settings administrator required</h2>
    <p className="mt-2">{message}</p>
    <p className="mt-3 text-amber-200/90">
      An installation operator can grant the capability to an explicit enabled
      account:
    </p>
    <code className="mt-2 block break-all rounded-md border border-amber-500/30 bg-slate-950/60 p-3 font-mono text-xs text-amber-100">
      pnpm run notifications:grant-admin -- &lt;user-id&gt;
    </code>
  </div>
);

export const ManageEmailPage = () => {
  const settings = useQuery({
    queryFn: () => notificationsApi.getSettings(),
    queryKey: emailSettingsQueryKey,
    retry: false,
  });

  const forbidden =
    settings.error instanceof ApiClientError && settings.error.status === 403
      ? settings.error
      : null;

  return (
    <>
      <PageHeader
        eyebrow="Manage"
        title="Email"
      />
      <div className="p-5 sm:p-8">
        {settings.isPending ? (
          <p className="text-slate-400">Loading email settings…</p>
        ) : settings.error ? (
          forbidden ? (
            <OwnerRequired message={forbidden.message} />
          ) : (
            <div className="max-w-2xl rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-100">
              {settings.error instanceof Error
                ? settings.error.message
                : 'The email settings could not be loaded.'}
              <button
                className="ml-3 font-semibold text-cyan-300 hover:text-cyan-200"
                onClick={() => {
                  void settings.refetch();
                }}
                type="button"
              >
                Try again
              </button>
            </div>
          )
        ) : settings.data ? (
          <EmailSettingsForm
            key={settings.data.revision}
            settings={settings.data}
          />
        ) : null}
      </div>
    </>
  );
};
