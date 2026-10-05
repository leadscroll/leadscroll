import { useSession } from '@/lib/auth-client';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

export const AccountSessionCacheBoundary = ({
  children,
}: {
  readonly children: React.ReactNode;
}) => {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const userId = session?.user.id;
  const sessionId = session?.session.id;
  useEffect(() => {
    // Keys isolate rendering immediately; remove old identities and cancel their
    // requests as soon as the auth identity changes, including sign-out.
    const filters = {
      predicate: (query: { queryKey: readonly unknown[] }) =>
        query.queryKey[0] === 'account-sessions' &&
        (query.queryKey[1] !== userId || query.queryKey[2] !== sessionId),
    };
    void queryClient.cancelQueries(filters);
    queryClient.removeQueries(filters);
  }, [queryClient, sessionId, userId]);
  return children;
};
