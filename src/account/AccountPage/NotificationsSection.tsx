import { Notice } from '@/components/Notice';
import { Button } from '@/components/ui/Button';
import {
  type NotificationAvailability,
  type NotificationHistoryView,
} from '@/domain/schemas';
import {
  notificationHistoryQueryKey,
  notificationPreferenceQueryKey,
  notificationsApi,
} from '@/notifications/api';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Link } from 'wouter';

const AVAILABILITY_NOTES: Record<NotificationAvailability, string> = {
  configured:
    'Alert emails are sent from the installation sender to your account email.',
  disabled:
    'Email notifications are not enabled on this installation yet. Your preference is saved and applies once an administrator enables a provider.',
  misconfigured:
    'Email is not fully configured yet. Your preference is saved and alerts start after an administrator finishes setup.',
  unavailable:
    'Sending is paused after a provider configuration error. Your preference is saved; alerts resume when the administrator resolves it.',
};

const availabilityNote = (availability: NotificationAvailability): string =>
  AVAILABILITY_NOTES[availability];

const formatTimestamp = (value: string): string =>
  new Date(value).toLocaleString();

export const NotificationsSection = ({
  email,
  userId,
}: {
  readonly email: string;
  readonly userId: string;
}) => {
  const queryClient = useQueryClient();
  const preference = useQuery({
    queryFn: () => notificationsApi.getPreference(),
    queryKey: notificationPreferenceQueryKey(userId),
  });
  const history = useInfiniteQuery<
    NotificationHistoryView,
    Error,
    InfiniteData<NotificationHistoryView>,
    readonly unknown[],
    string | undefined
  >({
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    initialPageParam: undefined,
    queryFn: ({ pageParam }) => notificationsApi.history(pageParam),
    queryKey: notificationHistoryQueryKey(userId),
  });
  const [draft, setDraft] = useState<boolean | null>(null);
  const saved = preference.data?.newLeadEmail ?? false;
  const value = draft ?? saved;

  const save = useMutation({
    mutationFn: (newLeadEmail: boolean) =>
      notificationsApi.updatePreference(newLeadEmail),
    onSuccess: (view, newLeadEmail) => {
      queryClient.setQueryData(notificationPreferenceQueryKey(userId), view);
      setDraft(null);
      toast.success(
        newLeadEmail
          ? 'New lead emails turned on'
          : 'New lead emails turned off',
      );
    },
  });

  const rows = history.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <section className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/40 p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
        Notifications
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        Alerts about newly created leads only. Emails link to the authenticated
        lead page.
      </p>

      {preference.isPending ? (
        <p className="mt-4 text-sm text-slate-400">Loading preference…</p>
      ) : preference.error ? (
        <div className="mt-4">
          <Notice error={preference.error} />
        </div>
      ) : (
        <>
          <label className="mt-4 flex items-start gap-3 text-sm text-slate-200">
            <input
              aria-label="New lead emails"
              checked={value}
              className="mt-0.5"
              disabled={save.isPending}
              name="newLeadEmail"
              onChange={(event) => {
                setDraft(event.target.checked);
              }}
              type="checkbox"
            />
            <span>
              <span className="font-medium">New lead emails</span>
              <span className="mt-0.5 block text-xs text-slate-500">
                {availabilityNote(preference.data?.availability ?? 'disabled')}
              </span>
            </span>
          </label>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button
              disabled={save.isPending || draft === null}
              onClick={() => {
                if (draft !== null) {
                  save.mutate(draft);
                }
              }}
            >
              {save.isPending ? 'Saving…' : 'Save preference'}
            </Button>
            <span className="text-xs text-slate-500">Sent to {email}</span>
          </div>
          {save.error && (
            <div className="mt-3">
              <Notice error={save.error} />
            </div>
          )}
        </>
      )}

      <div className="mt-6 border-t border-slate-800 pt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Delivery history
        </h3>
        {history.isPending ? (
          <p className="mt-3 text-sm text-slate-400">Loading history…</p>
        ) : history.error ? (
          <div className="mt-3">
            <Notice error={history.error} />
          </div>
        ) : rows.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">
            No notification history yet.
          </p>
        ) : (
          <>
            <ul className="mt-3 grid gap-2">
              {rows.map((row) => (
                <li
                  className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/60 px-4 py-3"
                  key={row.id}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-100">
                      {row.statusLabel}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {row.reasonLabel ?? formatTimestamp(row.createdAt)}
                    </p>
                  </div>
                  <Link
                    className="text-xs font-semibold text-cyan-300 hover:text-cyan-200"
                    href={`/leads/${row.leadId}`}
                  >
                    Open lead
                  </Link>
                </li>
              ))}
            </ul>
            {history.hasNextPage && (
              <div className="mt-3">
                <Button
                  disabled={history.isFetchingNextPage}
                  onClick={() => {
                    void history.fetchNextPage();
                  }}
                  tone="secondary"
                >
                  {history.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
};
