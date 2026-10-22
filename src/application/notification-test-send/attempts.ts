import { testViewForState } from '@/application/email-test-view';
import {
  type DomainError,
  domainError,
  type PersistenceError,
} from '@/application/errors';
import { type InstallationConfigStoreService } from '@/application/installation-config-store';
import {
  type AuditWrite,
  EMAIL_TEST_MIN_INTERVAL_MS,
  EMAIL_TEST_ROLLING_LIMIT,
  EMAIL_TEST_WINDOW_MS,
  type EmailTestState,
  type EmailTestView,
  type InstallationConfig,
} from '@/domain/schemas';
import { Clock, Effect } from 'effect';

export type SendTestEmailInput = {
  actorEmail: string;
  actorUserId: string;
  canonicalOrigin: string;
  expectedRevision: number;
  requestId: string;
};

export type TestCompletion = {
  providerMessageId?: null | string;
  reasonCode: null | string;
  status: 'accepted' | 'ambiguous' | 'configuration_error' | 'rejected';
};

type TestReconciliation =
  { kind: 'reconciled'; last: EmailTestState } | { kind: 'stale' };

type TestReservation =
  | { document: InstallationConfig; kind: 'reserved' }
  | { kind: 'daily_limited' }
  | { kind: 'duplicate'; last: EmailTestState }
  | { kind: 'foreign' }
  | { kind: 'rate_limited' };

const configUnavailable = () =>
  domainError(
    'config_unavailable',
    'The installation configuration is unreadable. Restore it from a backup or ask an operator to repair it.',
  );

const configurationBusy = () =>
  domainError(
    'configuration_busy',
    'The test request could not be committed. Try again.',
  );

export const readOrFail = (store: InstallationConfigStoreService) =>
  store.read.pipe(
    Effect.catchTag('InstallationConfigUnavailable', () =>
      Effect.fail(configUnavailable()),
    ),
  );

/**
 * Reserves one attempt in the configuration document. The rolling window is
 * pruned here, limits are re-evaluated after every CAS retry, and only the
 * most recent request id is retained for own-actor duplicate protection.
 */
export const reserveTestAttempt = (
  store: InstallationConfigStoreService,
  input: {
    actorUserId: string;
    expectedRevision: number;
    requestId: string;
  },
): Effect.Effect<TestReservation, DomainError | PersistenceError, never> =>
  store
    .transact<TestReservation>(input.actorUserId, (row) =>
      Effect.gen(function* () {
        if (row.document.revision !== input.expectedRevision) {
          return yield* Effect.fail(
            domainError(
              'revision_conflict',
              'Email settings changed in another session. Reload and try again.',
            ),
          );
        }

        const last = row.document.emailTest.last;
        if (last !== null && last.requestId === input.requestId) {
          return last.actorUserId === input.actorUserId
            ? { result: { kind: 'duplicate', last } as const }
            : { result: { kind: 'foreign' } as const };
        }

        const nowMs = yield* Clock.currentTimeMillis;
        const recent = row.document.emailTest.recent.filter(
          (entry) => entry.at > nowMs - EMAIL_TEST_WINDOW_MS,
        );
        if (
          recent.some((entry) => entry.at > nowMs - EMAIL_TEST_MIN_INTERVAL_MS)
        ) {
          return { result: { kind: 'rate_limited' } as const };
        }

        if (recent.length >= EMAIL_TEST_ROLLING_LIMIT) {
          return { result: { kind: 'daily_limited' } as const };
        }

        const provider =
          row.document.email.provider === 'disabled'
            ? null
            : row.document.email.provider;
        const reserved: InstallationConfig = {
          ...row.document,
          emailTest: {
            last: {
              actorUserId: input.actorUserId,
              at: nowMs,
              configRevision: row.document.revision,
              outcome: 'sending',
              provider,
              providerMessageId: null,
              reasonCode: null,
              requestId: input.requestId,
            },
            recent: [...recent, { actorUserId: input.actorUserId, at: nowMs }],
          },
        };
        return {
          audit: [],
          document: reserved,
          result: { document: reserved, kind: 'reserved' } as const,
        };
      }),
    )
    .pipe(
      Effect.map((transaction) => transaction.result),
      Effect.catchTag('InstallationConfigConflict', () =>
        Effect.fail(configurationBusy()),
      ),
      Effect.catchTag('InstallationConfigUnavailable', () =>
        Effect.fail(configUnavailable()),
      ),
    );

/**
 * Reconciles only the reserved request id and audits the outcome atomically.
 * When the reservation was replaced by a concurrent actor or request, the
 * current row is reported `stale` and never returned, so a slow completion
 * cannot surface another actor's result.
 */
export const reconcileTestOutcome = (
  store: InstallationConfigStoreService,
  input: {
    actorUserId: string;
    completion: TestCompletion;
    requestId: string;
  },
): Effect.Effect<TestReconciliation, DomainError | PersistenceError, never> =>
  store
    .transact<TestReconciliation>(input.actorUserId, (row) => {
      const last = row.document.emailTest.last;
      if (
        last === null ||
        last.requestId !== input.requestId ||
        last.actorUserId !== input.actorUserId
      ) {
        return Effect.succeed({ result: { kind: 'stale' } as const });
      }

      const nextLast: EmailTestState = {
        ...last,
        outcome: input.completion.status,
        providerMessageId: input.completion.providerMessageId ?? null,
        reasonCode: input.completion.reasonCode,
      };
      const document: InstallationConfig = {
        ...row.document,
        emailTest: { ...row.document.emailTest, last: nextLast },
      };
      const audit: AuditWrite[] = [
        {
          action: 'email.test_sent',
          changes: [
            {
              after: nextLast.outcome,
              before: 'sending',
              field: 'test.outcome',
            },
            {
              after: nextLast.provider,
              before: last.provider,
              field: 'test.provider',
            },
            {
              after: nextLast.reasonCode,
              before: last.reasonCode,
              field: 'test.reason',
            },
          ],
          resourceId: null,
          resourceType: 'installation.email_test',
        },
      ];
      return Effect.succeed({
        audit,
        document,
        result: { kind: 'reconciled', last: nextLast } as const,
      });
    })
    .pipe(
      Effect.map((transaction) => transaction.result),
      // Exhausted CAS retries lose this completion honestly rather than
      // overwriting a concurrent writer.
      Effect.catchTag('InstallationConfigConflict', () =>
        Effect.succeed({ kind: 'stale' } as const),
      ),
      Effect.catchTag('InstallationConfigUnavailable', () =>
        Effect.fail(configUnavailable()),
      ),
    );

/**
 * Reads the caller's own stored attempt from the current document.
 */
const readOwnedTest = (
  store: InstallationConfigStoreService,
  input: SendTestEmailInput,
): Effect.Effect<EmailTestView | null, DomainError | PersistenceError, never> =>
  Effect.gen(function* () {
    const row = yield* readOrFail(store);
    const last = row.document.emailTest.last;
    if (
      last === null ||
      last.requestId !== input.requestId ||
      last.actorUserId !== input.actorUserId
    ) {
      return null;
    }

    return testViewForState(last);
  });

export const readOwnedTestOrFail = (
  store: InstallationConfigStoreService,
  input: SendTestEmailInput,
) =>
  Effect.gen(function* () {
    const view = yield* readOwnedTest(store, input);
    if (view === null) {
      return yield* Effect.fail(
        domainError(
          'test_request_conflict',
          'This test request belongs to another account. Start a new test.',
        ),
      );
    }

    return view;
  });
