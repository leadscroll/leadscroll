import { emailSettingsQueryKey, notificationsApi } from '../api';
import { EmailSettingsForm } from './EmailSettingsForm';
import { PageHeader } from '@/components/PageHeader';
import { useSession } from '@/lib/auth-client';
import { ApiClientError } from '@/lib/http';
import { useQuery } from '@tanstack/react-query';

const OwnerRequired = ({ message }: { readonly message: string }) => (
  <div className="max-w-2xl rounded-xl border border-amber-500/30 bg-amber-500/10 p-5 text-sm text-amber-100">
    <h2 className="font-semibold">Email settings administrator required</h2>
    <p className="mt-2">{message}</p>
    <p className="mt-3 text-amber-200/90">
      An installation operator can grant the permission to an explicit enabled
      account from the installation repository:
    </p>
    <code className="mt-2 block break-all rounded-md border border-amber-500/30 bg-slate-950/60 p-3 font-mono text-xs text-amber-100">
      pnpm run notifications:grant-admin -- &lt;user-id&gt;
    </code>
    <p className="mt-2 text-amber-200/90">
      Copied template installations have the same command; add{' '}
      <code>--remote</code> to target the deployed database.
    </p>
  </div>
);

export const ManageEmailPage = () => {
  const { data: session } = useSession();
  const userId = session?.user.id ?? null;
  const settings = useQuery({
    enabled: userId !== null,
    queryFn: () => notificationsApi.getSettings(),
    queryKey: emailSettingsQueryKey(userId ?? 'anonymous'),
    // Settings are edited concurrently. Refresh on focus so another
    // administrator's save surfaces as a reload/conflict banner while the
    // current draft stays intact (the global default is off).
    refetchOnWindowFocus: true,
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
        {userId === null || settings.isPending ? (
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
            settings={settings.data}
            userId={userId}
          />
        ) : null}
      </div>
    </>
  );
};
