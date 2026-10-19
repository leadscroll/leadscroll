import { Notice } from '@/components/Notice';
import { Button } from '@/components/ui/Button';
import { type NotificationAvailability } from '@/domain/schemas';
import {
  notificationPreferenceQueryKey,
  notificationsApi,
} from '@/notifications/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

const AVAILABILITY_NOTES: Record<NotificationAvailability, string> = {
  configured:
    'Alert emails are sent best-effort to your account email when a lead is created. There is no retry or delivery history.',
  disabled:
    'Email sending is off on this installation. Your preference is saved and applies when a sending method is turned on.',
  misconfigured:
    'A sending method is selected but not fully configured. Your preference is saved and alerts start after setup is finished.',
};

const availabilityNote = (availability: NotificationAvailability): string =>
  AVAILABILITY_NOTES[availability];

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

  return (
    <section className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/40 p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
        Notifications
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        Alerts about newly created leads only. Emails link to the authenticated
        lead page and are sent without retry.
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
    </section>
  );
};
