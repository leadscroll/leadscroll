import {
  readOrFail,
  readOwnedTestOrFail,
  reconcileTestOutcome,
  reserveTestAttempt,
  type SendTestEmailInput,
  type TestCompletion,
} from './attempts';
import { Deployment } from '@/application/deployment';
import { testViewForState } from '@/application/email-test-view';
import { domainError } from '@/application/errors';
import { InstallationConfigStore } from '@/application/installation-config-store';
import {
  savedConfigurationTestable,
  stateFromDocument,
} from '@/application/notification-settings';
import { type InstallationEmailConfig } from '@/domain/schemas';
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  type EmailEnvelope,
  type SendResult,
  testDeliveryKeyFor,
} from '@/notifications/email';
import { EmailProviderResolver } from '@/notifications/email-provider';
import { renderTestEmail } from '@/notifications/templates';
import {
  recordProviderAmbiguous,
  recordProviderDuration,
} from '@/telemetry/metrics';
import { Clock, Effect, Exit, Result } from 'effect';

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
        domainError(
          'email_disabled',
          'Choose a sending method before sending a test.',
        ),
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
        domainError(
          'email_disabled',
          'Choose a sending method before sending a test.',
        ),
      );
    }

    let completion: TestCompletion;
    const providerEither = yield* Effect.result(
      resolver.resolve(reservedSettings),
    );
    if (Result.isFailure(providerEither)) {
      completion = {
        reasonCode: providerEither.failure.reason,
        status: 'configuration_error',
      };
    } else {
      const provider = providerEither.success;
      const sendStartedAt = yield* Clock.currentTimeMillis;
      const sendExit = yield* Effect.exit(
        provider
          .send({
            deliveryKey: testDeliveryKeyFor(input.requestId),
            envelope: buildTestEnvelope(reservedSettings, input),
            timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
          })
          .pipe(
            Effect.withSpan('email.provider.send', {
              attributes: { 'email.provider': provider.kind },
              kind: 'client',
            }),
          ),
      );
      yield* recordProviderDuration(
        provider.kind,
        (yield* Clock.currentTimeMillis) - sendStartedAt,
      );
      const result: SendResult = Exit.isSuccess(sendExit)
        ? sendExit.value
        : {
            kind: 'ambiguous',
            provider: provider.kind,
            reason: 'unexpected_error',
          };
      if (result.kind === 'ambiguous') {
        yield* recordProviderAmbiguous(provider.kind, result.reason);
      }

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
  }).pipe(Effect.withSpan('email.test'));
