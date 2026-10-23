import {
  appQuery,
  copyToClipboard,
  publicIntakeSnippet,
  statusTone,
  TOKEN_DEFAULT_TTL_MS,
  tokenStatus,
} from '../shared';
import { CreateTokenDialog } from './CreateTokenDialog';
import { ErrorState } from '@/components/ErrorState';
import { PageHeader as Header } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { toLocalInputValue } from '@/lib/datetime';
import { request } from '@/lib/http';
import { cn } from '@/lib/styles';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';

export const TokensPage = () => {
  const queryClient = useQueryClient();
  const [createNonce, setCreateNonce] = useState(0);
  const [defaultExpiration, setDefaultExpiration] = useState('');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const tokens = useQuery(appQuery.tokens());
  const revoke = useMutation({
    mutationFn: (id: string) =>
      request(`/v1/tokens/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tokens'] }),
  });
  return (
    <>
      <Header
        action={
          <Button
            onClick={() => {
              setCreateNonce((value) => value + 1);
              setDefaultExpiration(
                toLocalInputValue(new Date(Date.now() + TOKEN_DEFAULT_TTL_MS)),
              );
              setShowCreateDialog(true);
            }}
          >
            <Plus size={16} /> Create token
          </Button>
        }
        eyebrow="Manage"
        title="Intake tokens"
      />
      <div className="p-5 sm:p-8">
        {tokens.isPending ? (
          <p className="text-slate-400">Loading tokens…</p>
        ) : tokens.error ? (
          <ErrorState error={tokens.error} />
        ) : tokens.data?.length ? (
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-900 text-xs uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3">Expires</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Revoke</th>
                </tr>
              </thead>
              <tbody>
                {tokens.data.map((token) => (
                  <tr
                    className="border-t border-slate-800"
                    key={token.id}
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-100">{token.name}</p>
                      {token.type === 'browser' && token.token !== null ? (
                        <div className="mt-1 flex items-center gap-2">
                          <code
                            className="max-w-72 truncate font-mono text-xs text-slate-500"
                            title={token.token}
                          >
                            {token.token}
                          </code>
                          <button
                            className="text-xs font-semibold text-cyan-300 hover:text-cyan-200"
                            onClick={() => {
                              void copyToClipboard(
                                token.token ?? '',
                                'Token copied',
                              );
                            }}
                            type="button"
                          >
                            Copy
                          </button>
                          <button
                            className="text-xs font-semibold text-cyan-300 hover:text-cyan-200"
                            onClick={() => {
                              void copyToClipboard(
                                publicIntakeSnippet(token.token ?? ''),
                                'Snippet copied',
                              );
                            }}
                            type="button"
                          >
                            Snippet
                          </button>
                        </div>
                      ) : (
                        <code className="font-mono text-xs text-slate-500">
                          {token.prefix}…
                        </code>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'rounded px-2 py-0.5 text-xs',
                          token.type === 'browser'
                            ? 'bg-cyan-500/15 text-cyan-300'
                            : 'bg-slate-800 text-slate-400',
                        )}
                      >
                        {token.type === 'browser' ? 'Browser' : 'API'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {new Date(token.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-slate-400">
                      {token.expiresAt
                        ? new Date(token.expiresAt).toLocaleDateString()
                        : 'No expiry'}
                    </td>
                    <td
                      className={cn(
                        'px-4 py-3',
                        statusTone[tokenStatus(token)],
                      )}
                    >
                      {tokenStatus(token)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        {!token.revokedAt && (
                          <Button
                            disabled={revoke.isPending}
                            onClick={() => revoke.mutate(token.id)}
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
          <p className="text-sm text-slate-400">No intake tokens yet.</p>
        )}
        {revoke.error && (
          <div className="mt-4">
            <ErrorState error={revoke.error} />
          </div>
        )}
      </div>
      {showCreateDialog ? (
        <CreateTokenDialog
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
