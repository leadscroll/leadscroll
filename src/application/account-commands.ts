import { PersistenceError } from './errors';
import { type SessionIdentity } from '@/auth/access';
import {
  type Env,
  listAccountSessions,
  revokeAccountSession,
  revokeOtherAccountSessions,
} from '@/db/repository';
import { Effect } from 'effect';

export type AccountSessionIdentity = NonNullable<SessionIdentity['session']>;
const persist = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => new PersistenceError({ cause }),
    try: operation,
  });

export const listAccountSessionsCommand = (
  environment: Env,
  identity: AccountSessionIdentity,
) =>
  persist(async () =>
    (await listAccountSessions(environment, identity.userId)).map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      current: row.id === identity.id,
      expiresAt: row.expiresAt.toISOString(),
    })),
  );

export const revokeAccountSessionCommand = (
  environment: Env,
  identity: AccountSessionIdentity,
  id: string,
) =>
  Effect.gen(function* () {
    if (id === identity.id) {
      return 'current' as const;
    }

    const revoked = yield* persist(() =>
      revokeAccountSession(environment, identity.userId, id),
    );
    return revoked ? ('revoked' as const) : ('missing' as const);
  });

export const revokeOtherAccountSessionsCommand = (
  environment: Env,
  identity: AccountSessionIdentity,
) =>
  persist(() =>
    revokeOtherAccountSessions(environment, identity.userId, identity.id),
  );
