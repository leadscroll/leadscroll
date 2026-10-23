import { sessionQueryKey } from './sessionQueryKey';
import { describeAgent, formatTimestamp } from '@/account/sessionPresentation';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Notice } from '@/components/Notice';
import { Button } from '@/components/ui/Button';
import { type AccountSessionView } from '@/domain/schemas';
import { request } from '@/lib/http';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

export const SessionsSection = ({
  sessionId,
  userId,
}: {
  readonly sessionId: string;
  readonly userId: string;
}) => {
  const queryKey = sessionQueryKey(userId, sessionId);
  const queryClient = useQueryClient();
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);
  const actionLock = useRef(false);
  const releaseAction = () => {
    actionLock.current = false;
  };

  const sessions = useQuery({
    enabled: Boolean(userId && sessionId),
    queryFn: ({ signal }) =>
      request<AccountSessionView[]>('/v1/account/sessions', { signal }),
    queryKey,
  });

  const revokeOne = useMutation({
    mutationFn: (id: string) =>
      request<undefined>(`/v1/account/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.success('Session revoked');
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const revokeOthers = useMutation({
    mutationFn: () =>
      request<{ revoked: number }>('/v1/account/sessions/revoke-others', {
        method: 'POST',
      }),
    onSuccess: async (result) => {
      toast.success(
        result.revoked === 1
          ? 'Signed out 1 other device'
          : `Signed out ${result.revoked} other devices`,
      );
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const pending = revokeOne.isPending || revokeOthers.isPending;
  const rows = sessions.data ?? [];
  const otherCount = rows.filter((row) => !row.current).length;

  return (
    <section className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/40 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
          Sessions
        </h2>
        {otherCount > 0 && (
          <Button
            disabled={pending}
            onClick={() => {
              setConfirmRevokeAll(true);
            }}
            tone="secondary"
          >
            Sign out other devices ({otherCount})
          </Button>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Devices currently signed in to this account.
      </p>
      {sessions.isPending ? (
        <p className="mt-4 text-sm text-slate-400">Loading sessions…</p>
      ) : sessions.error ? (
        <div className="mt-4">
          <Notice error={sessions.error} />
        </div>
      ) : rows.length === 0 ? (
        <p className="mt-4 text-sm text-slate-400">No active sessions.</p>
      ) : (
        <ul className="mt-4 grid grid-cols-1 gap-2">
          {rows.map((row) => (
            <li
              className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/60 px-4 py-3"
              key={row.id}
            >
              <div className="min-w-0 max-w-full flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-100">
                  {describeAgent(row.userAgent)}
                  {row.current && (
                    <span className="rounded bg-cyan-400/15 px-1.5 py-0.5 text-xs font-semibold text-cyan-300">
                      This device
                    </span>
                  )}
                </p>
                <p className="mt-0.5 truncate text-xs text-slate-500">
                  {row.ipAddress ?? 'unknown IP'} · signed in{' '}
                  {formatTimestamp(row.createdAt)} · expires{' '}
                  {formatTimestamp(row.expiresAt)}
                </p>
              </div>
              {!row.current && (
                <Button
                  disabled={pending}
                  onClick={async () => {
                    if (actionLock.current) {
                      return;
                    }

                    actionLock.current = true;
                    try {
                      await revokeOne.mutateAsync(row.id);
                    } catch {
                      /* Error is displayed below. */
                    } finally {
                      releaseAction();
                    }
                  }}
                  tone="secondary"
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {revokeOne.error && (
        <div className="mt-4">
          <Notice error={revokeOne.error} />
        </div>
      )}
      {revokeOthers.error && (
        <div className="mt-4">
          <Notice error={revokeOthers.error} />
        </div>
      )}
      <ConfirmDialog
        confirmLabel="Sign out"
        description={`Sign out ${otherCount} ${
          otherCount === 1 ? 'device' : 'devices'
        }? They will need the password to sign in again.`}
        onConfirm={async () => {
          if (actionLock.current) {
            return;
          }

          actionLock.current = true;
          try {
            await revokeOthers.mutateAsync();
            setConfirmRevokeAll(false);
          } catch {
            /* Error is displayed below. */
          } finally {
            releaseAction();
          }
        }}
        onOpenChange={setConfirmRevokeAll}
        open={confirmRevokeAll}
        pending={pending}
        pendingLabel="Signing out…"
        title="Sign out other devices"
      />
    </section>
  );
};
