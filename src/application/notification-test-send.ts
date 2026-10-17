/**
 * Explicit administrator test email.
 *
 * One attempt per request id: the reservation is written inside the
 * installation document before any outbound call, the rolling 1/minute and
 * 5/24-hour windows are re-evaluated after every lost compare-and-swap race,
 * and completion reconciles only the caller's own reserved id. There is no
 * automatic retry, replay, or durable attempt table.
 */

import { Deployment } from '@/application/deployment';
import { testViewForState } from '@/application/email-test-view';
import {
  type DomainError,
  domainError,
  type PersistenceError,
} from '@/application/errors';
import { InstallationConfigStore } from '@/application/installation-config-store';
import {
  savedConfigurationTestable,
  stateFromDocument,
} from '@/application/notification-settings';
import {
  type AuditWrite,
  EMAIL_TEST_MIN_INTERVAL_MS,
  EMAIL_TEST_ROLLING_LIMIT,
  EMAIL_TEST_WINDOW_MS,
  type EmailTestState,
  type EmailTestView,
  type InstallationConfig,
  type InstallationEmailConfig,
} from '@/domain/schemas';
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  type EmailEnvelope,
  type SendResult,
  testDeliveryKeyFor,
} from '@/notifications/email';
import { EmailProviderResolver } from '@/notifications/email-provider';
import { renderTestEmail } from '@/notifications/templates';
import { Clock, Effect, Either, Exit } from 'effect';

export type SendTestEmailInput = {
  actorEmail: string;
  actorUserId: string;
  canonicalOrigin: string;
  expectedRevision: number;
  requestId: string;
};

type TestCompletion = {
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

const readOrFail = (store: InstallationConfigStore['Type']) =>
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
const reserveTestAttempt = (
  store: InstallationConfigStore['Type'],
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
const reconcileTestOutcome = (
  store: InstallationConfigStore['Type'],
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
  store: InstallationConfigStore['Type'],
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

const readOwnedTestOrFail = (
  store: InstallationConfigStore['Type'],
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

const completionForTestResult = (
  result: SendResult,
): {
  reasonCode: null | string;
  status: 'accepted' | 'ambiguous' | 'rejected';
} => {
  if (result.kind === 'accepted') {
    return { reasonCode: null, status: 'accepted' };
  }

  if (result.kind === 'ambiguous') {
    return { reasonCode: result.reason, status: 'ambiguous' };
  }

  return { reasonCode: result.reason, status: 'rejected' };
};

const buildTestEnvelope = (
  settings: InstallationEmailConfig,
  input: SendTestEmailInput,
): EmailEnvelope => {
  const rendered = renderTestEmail({
    origin: settings.canonicalOrigin ?? input.canonicalOrigin,
  });
  return {
    from: {
      email: settings.fromEmail ?? '',
      ...(settings.fromName === null ? {} : { name: settings.fromName }),
    },
    html: rendered.html,
    subject: rendered.subject,
    text: rendered.text,
    to: input.actorEmail.trim().toLowerCase(),
  };
};

/**
 * Sends one explicit administrator test to the caller's own account email
 * using the saved configuration. Accepted, rejected, and unknown outcomes are
 * reported honestly; test-state writes never change the user-visible settings
 * revision.
 */
export const sendTestEmailCommand = (input: SendTestEmailInput) =>
  Effect.gen(function* () {
    const store = yield* InstallationConfigStore;
    const capabilities = yield* Deployment;
    const resolver = yield* EmailProviderResolver;

    const row = yield* readOrFail(store);
    if (row.document.revision !== input.expectedRevision) {
      return yield* Effect.fail(
        domainError(
          'revision_conflict',
          'Email settings changed in another session. Reload and try again.',
        ),
      );
    }

    const state = stateFromDocument(capabilities, row.document);
    const testable = savedConfigurationTestable(state);
    if (!testable.ok) {
      return yield* Effect.fail(domainError(testable.code, testable.message));
    }

    if (state.provider === null) {
      return yield* Effect.fail(
        domainError('email_disabled', 'Choose a provider first.'),
      );
    }

    const reservation = yield* reserveTestAttempt(store, {
      actorUserId: input.actorUserId,
      expectedRevision: input.expectedRevision,
      requestId: input.requestId,
    });
    if (reservation.kind === 'foreign') {
      return yield* Effect.fail(
        domainError(
          'test_request_conflict',
          'This test request id is already in use. Start a new test.',
        ),
      );
    }

    if (reservation.kind === 'rate_limited') {
      return yield* Effect.fail(
        domainError(
          'test_rate_limited',
          'A test email was sent within the last minute. Try again shortly.',
          { retryAfterSeconds: 60 },
        ),
      );
    }

    if (reservation.kind === 'daily_limited') {
      return yield* Effect.fail(
        domainError(
          'test_daily_limited',
          'The daily limit of five test emails has been reached.',
          { retryAfterSeconds: 86_400 },
        ),
      );
    }

    if (reservation.kind === 'duplicate') {
      return testViewForState(reservation.last);
    }

    // Use the exact document the reservation committed, so a concurrent
    // settings save after the reservation cannot retarget this send.
    const reservedState = stateFromDocument(capabilities, reservation.document);
    const reservedSettings = reservedState.settings;
    if (reservedSettings === null || reservedState.provider === null) {
      return yield* Effect.fail(
        domainError('email_disabled', 'Choose a provider first.'),
      );
    }

    let completion: TestCompletion;
    const providerEither = yield* Effect.either(
      resolver.resolve(reservedSettings),
    );
    if (Either.isLeft(providerEither)) {
      completion = {
        reasonCode: providerEither.left.reason,
        status: 'configuration_error',
      };
    } else {
      const provider = providerEither.right;
      const sendExit = yield* Effect.exit(
        provider.send({
          deliveryKey: testDeliveryKeyFor(input.requestId),
          envelope: buildTestEnvelope(reservedSettings, input),
          timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
        }),
      );
      const result: SendResult = Exit.isSuccess(sendExit)
        ? sendExit.value
        : {
            kind: 'ambiguous',
            provider: provider.kind,
            reason: 'unexpected_error',
          };
      const mapped = completionForTestResult(result);
      completion = {
        providerMessageId:
          result.kind === 'accepted' ? (result.messageId ?? null) : null,
        reasonCode: mapped.reasonCode,
        status: mapped.status,
      };
    }

    const reconciliation = yield* reconcileTestOutcome(store, {
      actorUserId: input.actorUserId,
      completion,
      requestId: input.requestId,
    });
    if (reconciliation.kind === 'reconciled') {
      return testViewForState(reconciliation.last);
    }

    // Our reservation was replaced by a concurrent actor or request. Never
    // return that row; only our own stored attempt or a safe conflict is
    // acceptable.
    return yield* readOwnedTestOrFail(store, input);
  });
