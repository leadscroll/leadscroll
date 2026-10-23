import { emailSettingsQueryKey, notificationsApi } from '../api';
import { EmailAvailabilityChip } from './EmailAvailabilityChip';
import { EmailSettingsPanel } from './EmailSettingsPanel';
import { PageHeader } from '@/components/PageHeader';
import { useSession } from '@/lib/auth-client';
import { useQuery } from '@tanstack/react-query';

export const ManageEmailPage = () => {
  const { data: session } = useSession();
  const userId = session?.user.id ?? null;
  const settings = useQuery({
    enabled: userId !== null,
    queryFn: () => notificationsApi.getSettings(),
    queryKey: emailSettingsQueryKey(userId ?? 'anonymous'),
    // Settings are edited concurrently. Refresh on focus so another staff
    // member's save surfaces as a reload/conflict banner while the current
    // draft stays intact (the global default is off).
    refetchOnWindowFocus: true,
    retry: false,
  });

  return (
    <>
      <PageHeader
        action={
          settings.data ? (
            <EmailAvailabilityChip
              availability={settings.data.readiness.availability}
            />
          ) : undefined
        }
        eyebrow="Manage"
        title="Email"
      />
      <div className="p-5 sm:p-8">
        {userId === null || settings.isPending ? (
          <p className="text-slate-400">Loading email settings…</p>
        ) : settings.error ? (
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
        ) : settings.data ? (
          <EmailSettingsPanel
            accountEmail={session?.user.email ?? ''}
            settings={settings.data}
            userId={userId}
          />
        ) : null}
      </div>
    </>
  );
};
