import { useSession } from '@/lib/auth-client';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

/**
 * Identity boundary for per-user caches. Query keys isolate rendering
 * immediately; this effect removes another identity's data as soon as auth
 * changes (including sign-out) so a subsequent login cannot read a previous
 * user's cached settings or capabilities.
 */
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
    const filters = {
      predicate: (query: { queryKey: readonly unknown[] }) => {
        const [root, keyUserId, keySessionId] = query.queryKey;
        if (root === 'account-sessions') {
          return keyUserId !== userId || keySessionId !== sessionId;
        }

        return root === 'account-capabilities' ||
          root === 'email-settings' ||
          root === 'notification-history' ||
          root === 'notification-preference'
          ? keyUserId !== userId
          : false;
      },
    };
    void queryClient.cancelQueries(filters);
    queryClient.removeQueries(filters);
  }, [queryClient, sessionId, userId]);
  return children;
};
