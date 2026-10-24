import { appQuery } from './shared';
import { type StaffAccount } from './types';
import { ErrorState } from '@/components/ErrorState';
import { PageHeader as Header } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { useSession } from '@/lib/auth-client';
import { request } from '@/lib/http';
import { cn } from '@/lib/styles';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export const StaffPage = () => {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const staff = useQuery(appQuery.staff());
  const setStatus = useMutation({
    mutationFn: (input: { disabled: boolean; id: string }) =>
      request<StaffAccount>(`/v1/staff/${input.id}`, {
        body: JSON.stringify({ disabled: input.disabled }),
        method: 'PATCH',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['staff'] }),
  });
  return (
    <>
      <Header
        eyebrow="Manage"
        title="Staff accounts"
      />
      <div className="p-5 sm:p-8">
        {staff.isPending ? (
          <p className="text-slate-400">Loading staff…</p>
        ) : staff.error ? (
          <ErrorState error={staff.error} />
        ) : staff.data?.length ? (
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-900 text-xs uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {staff.data.map((account) => {
                  const disabled = Boolean(account.disabledAt);
                  // The server is the authority on self-disable and
                  // last-enabled protection; hiding the control for the
                  // signed-in account keeps the list unambiguous without
                  // pretending the client enforces the rule.
                  const isSelf = session?.user?.id === account.id;
                  return (
                    <tr
                      className="border-t border-slate-800"
                      key={account.id}
                    >
                      <td className="px-4 py-3 font-medium text-slate-100">
                        {account.name}
                      </td>
                      <td className="px-4 py-3 text-slate-500">
                        {account.email}
                      </td>
                      <td
                        className={cn(
                          'px-4 py-3',
                          disabled ? 'text-rose-300' : 'text-emerald-300',
                        )}
                      >
                        {disabled ? 'disabled' : 'enabled'}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end">
                          {isSelf ? null : (
                            <Button
                              disabled={setStatus.isPending}
                              onClick={() =>
                                setStatus.mutate({
                                  disabled: !disabled,
                                  id: account.id,
                                })
                              }
                              tone={disabled ? 'secondary' : 'danger'}
                            >
                              {disabled ? 'Enable' : 'Disable'}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-slate-400">No staff accounts yet.</p>
        )}
        {setStatus.error && (
          <div className="mt-4">
            <ErrorState error={setStatus.error} />
          </div>
        )}
      </div>
    </>
  );
};
