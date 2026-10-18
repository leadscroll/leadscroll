import { type Env } from '../env';
import { apiTokens, idempotencyKeys } from '../schema';
import { getDatabase, hashToken, now } from '../shared';
import { type IntakeResponse } from '@/domain/intake';
import { and, eq, gt, isNull, or } from 'drizzle-orm';

/**
 * Intake authorization gate. A token is usable only while unrevoked,
 * scoped to intake:write, and unexpired: legacy rows with a NULL expiry
 * stay valid, and a row whose expiresAt is NOT strictly after the current
 * instant is rejected (expiresAt <= now means expired). The check runs
 * before any idempotency or domain write in the intake route.
 */
export const isIntakeToken = async (
  environment: Env,
  token: string,
): Promise<null | { id: string }> => {
  const tokenHash = await hashToken(token);
  const record = await getDatabase(environment)
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.tokenHash, tokenHash),
        eq(apiTokens.type, 'api'),
        eq(apiTokens.scope, 'intake:write'),
        isNull(apiTokens.revokedAt),
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now())),
      ),
    )
    .get();
  if (!record) {
    return null;
  }

  await getDatabase(environment)
    .update(apiTokens)
    .set({ lastUsedAt: now() })
    .where(eq(apiTokens.id, record.id))
    .run();
  return record;
};

/**
 * A browser intake token is write-only: it can create a lead through
 * `/v1/public/intakes/:token` and nothing else. Returns the token row
 * (id used as lead provenance) or null. The value is stored verbatim
 * because browser tokens are safe to embed and copy.
 */
export const isBrowserIntakeToken = async (
  environment: Env,
  token: string,
): Promise<null | { id: string }> => {
  const record = await getDatabase(environment)
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.token, token),
        eq(apiTokens.type, 'browser'),
        isNull(apiTokens.revokedAt),
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now())),
      ),
    )
    .get();
  if (!record) {
    return null;
  }

  await getDatabase(environment)
    .update(apiTokens)
    .set({ lastUsedAt: now() })
    .where(eq(apiTokens.id, record.id))
    .run();
  return record;
};

export type StoredIntakeKey = {
  requestHash: null | string;
  responseJson: Record<string, unknown>;
};

export const getIntakeKey = async (
  environment: Env,
  idempotencyKey: string,
): Promise<null | StoredIntakeKey> => {
  const row = await getDatabase(environment)
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.key, idempotencyKey)))
    .get();
  return row
    ? {
        requestHash: row.requestHash,
        responseJson: row.responseJson as Record<string, unknown>,
      }
    : null;
};

const checkStoredIntakeKey = (
  stored: null | StoredIntakeKey,
  requestHash: string,
): 'conflict' | 'legacy_unverifiable' | 'none' | 'replay' => {
  if (!stored) {
    return 'none';
  }

  if (stored.requestHash === null) {
    return 'legacy_unverifiable';
  }

  if (stored.requestHash === requestHash) {
    return 'replay';
  }

  return 'conflict';
};

export type IntakePersistenceOutcome =
  | { kind: 'conflict' }
  | { kind: 'created'; response: IntakeResponse }
  | { kind: 'legacy_unverifiable'; storedResponse: Record<string, unknown> }
  | { kind: 'replayed'; response: IntakeResponse };

/**
 * Interprets an already stored key for this request. Returns undefined when
 * no accepted row exists (i.e. this is a new submission). Used both before
 * the first write and after a batch collision, so concurrent callers apply
 * the exact same replay/conflict/legacy rules.
 */
export const outcomeForStoredIntakeKey = (
  stored: null | StoredIntakeKey,
  requestHash: string,
): IntakePersistenceOutcome | undefined => {
  if (stored === null) {
    return undefined;
  }

  switch (checkStoredIntakeKey(stored, requestHash)) {
    case 'conflict':
      return { kind: 'conflict' };
    case 'legacy_unverifiable':
      return {
        kind: 'legacy_unverifiable',
        storedResponse: stored.responseJson,
      };
    case 'replay':
      return {
        kind: 'replayed',
        response: stored.responseJson as unknown as IntakeResponse,
      };
    default:
      return undefined;
  }
};
