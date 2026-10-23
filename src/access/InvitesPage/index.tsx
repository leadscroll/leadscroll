import {
  appQuery,
  INVITE_DEFAULT_TTL_MS,
  inviteStatus,
  statusTone,
} from '../shared';
import { CreateInviteDialog } from './CreateInviteDialog';
import { ErrorState } from '@/components/ErrorState';
import { PageHeader as Header } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { toLocalInputValue } from '@/lib/datetime';
import { request } from '@/lib/http';
import { cn } from '@/lib/styles';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';

export const InvitesPage = () => {
  const queryClient = useQueryClient();
  const [createNonce, setCreateNonce] = useState(0);
  const [defaultExpiration, setDefaultExpiration] = useState('');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const invites = useQuery(appQuery.invites());
  const revoke = useMutation({
    mutationFn: (id: string) =>
      request(`/v1/invites/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invites'] }),
  });
  return (
    <>
      <Header
        action={
          <Button
            onClick={() => {
              setCreateNonce((value) => value + 1);
              setDefaultExpiration(
                toLocalInputValue(new Date(Date.now() + INVITE_DEFAULT_TTL_MS)),
              );
              setShowCreateDialog(true);
            }}
          >
            <Plus size={16} /> Create invite
          </Button>
        }
        eyebrow="Manage"
        title="Invitations"
      />
      <div className="p-5 sm:p-8">
        {invites.isPending ? (
          <p className="text-slate-400">Loading invitations…</p>
        ) : invites.error ? (
          <ErrorState error={invites.error} />
        ) : invites.data?.length ? (
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-900 text-xs uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3">Expires</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Revoke</th>
                </tr>
              </thead>
              <tbody>
                {invites.data.map((invite) => (
                  <tr
                    className="border-t border-slate-800"
                    key={invite.id}
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-100">
                        {invite.name}
                      </p>
                      <code className="font-mono text-xs text-slate-500">
                        {invite.prefix}…
                      </code>
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {new Date(invite.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-slate-400">
                      {invite.expiresAt
                        ? new Date(invite.expiresAt).toLocaleDateString()
                        : '—'}
                    </td>
                    <td
                      className={cn(
                        'px-4 py-3',
                        statusTone[inviteStatus(invite)],
                      )}
                    >
                      {inviteStatus(invite)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        {!invite.revokedAt && (
                          <Button
                            disabled={revoke.isPending}
                            onClick={() => revoke.mutate(invite.id)}
                            tone="danger"
                          >
                            Revoke
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-slate-400">No invites yet.</p>
        )}
        {revoke.error && (
          <div className="mt-4">
            <ErrorState error={revoke.error} />
          </div>
        )}
      </div>
      {showCreateDialog ? (
        <CreateInviteDialog
          defaultExpiration={defaultExpiration}
          key={createNonce}
          onOpenChange={(value) => {
            if (!value) {
              setShowCreateDialog(false);
            }
          }}
          open={showCreateDialog}
        />
      ) : null}
    </>
  );
};
