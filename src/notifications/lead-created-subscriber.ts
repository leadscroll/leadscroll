/**
 * Best-effort email subscriber for the `lead.created` event.
 *
 * Reads the current installation configuration through the store service and
 * the current opted-in enabled staff, excludes the manual creator, verifies
 * the lead still exists, and sends one generic message per recipient through
 * the resolved provider service.
 *
 * Work is bounded by `Effect.forEach` concurrency and a background budget
 * measured with `Clock`: the clock starts when the event reaches the
 * subscriber, so configuration/lead/recipient reads and credential
 * decryption consume it. Those reads cannot be canceled; if preparation
 * exhausts the budget, the per-send check reports the remaining recipients as
 * skipped instead of launching work. A provider whose send policy says a
 * timeout is uncancelable stops further launches for the batch (the
 * already-running sends may still finish) and the unsent recipients are
 * counted. There is no retry, replay, or durable delivery state.
 */

import { Deployment } from '@/application/deployment';
import { persist } from '@/application/errors';
import { InstallationConfigStore } from '@/application/installation-config-store';
import { stateFromDocument } from '@/application/notification-settings';
import { type Env, getLead, listLeadCreatedRecipients } from '@/db/repository';
import { type InstallationEmailConfig } from '@/domain/schemas';
import { type EmailEnvelope, leadDeliveryKey } from '@/notifications/email';
import { EmailProviderResolver } from '@/notifications/email-provider';
import {
  type LeadCreatedEvent,
  type LeadCreatedSubscriber,
} from '@/notifications/events';
import { logNotificationEventOutcome } from '@/notifications/logging';
import { renderNewLeadNotification } from '@/notifications/templates';
import { Clock, Effect, Either, Exit, Ref } from 'effect';

/**
 * Modest concurrency: provider calls overlap without unbounded fan-out.
 */
export const NOTIFICATION_CONCURRENCY = 4;
/**
 * Overall background budget, below the Worker `waitUntil` lifetime.
 */
export const NOTIFICATION_BUDGET_MS = 20_000;
/**
 * Per-provider-call timeout.
 */
export const NOTIFICATION_PROVIDER_TIMEOUT_MS = 10_000;

type RecipientOutcome =
  | { kind: 'accepted' }
  | { kind: 'failed'; reason: string }
  | { kind: 'skipped'; reason: 'budget_exhausted' | 'uncancelable_timeout' };

const buildLeadEnvelope = (
  settings: InstallationEmailConfig,
  origin: string,
  leadId: string,
  recipientEmail: string,
): EmailEnvelope => {
  const rendered = renderNewLeadNotification({ leadId, origin });
  return {
    from: {
      email: settings.fromEmail ?? '',
      ...(settings.fromName === null ? {} : { name: settings.fromName }),
    },
    html: rendered.html,
    subject: rendered.subject,
    text: rendered.text,
    to: recipientEmail.trim().toLowerCase(),
  };
};

const skipped = (event: LeadCreatedEvent, reasonCode: string): void => {
  logNotificationEventOutcome({
    eventKind: 'lead.created',
    leadId: event.leadId,
    outcome: 'skipped',
    reasonCode,
  });
};

export const createLeadCreatedEmailSubscriber = (
  environment: Env,
): LeadCreatedSubscriber => {
  return (event: LeadCreatedEvent) =>
    Effect.gen(function* () {
      const store = yield* InstallationConfigStore;
      const capabilities = yield* Deployment;
      const resolver = yield* EmailProviderResolver;

      // Entry time: configuration/lead/recipient reads and credential
      // decryption all consume the budget.
      const startedAt = yield* Clock.currentTimeMillis;
      const configExit = yield* Effect.either(store.read);
      if (Either.isLeft(configExit)) {
        // The only failure variants are an unreadable document or a database
        // fault; both are redacted to a skipped configuration outcome.
        skipped(event, 'config_invalid');
        return;
      }

      const state = stateFromDocument(capabilities, configExit.right.document);
      const settings = state.settings;
      if (settings === null || settings.provider === 'disabled') {
        skipped(event, settings === null ? 'not_configured' : 'disabled');
        return;
      }

      if (state.availability !== 'configured') {
        skipped(event, state.readinessReason ?? 'not_configured');
        return;
      }

      const origin = settings.canonicalOrigin;
      if (origin === null || origin.trim().length === 0) {
        skipped(event, 'canonical_origin_missing');
        return;
      }

      const lead = yield* persist(() => getLead(environment, event.leadId));
      if (lead === null || lead.deletedAt !== null) {
        skipped(event, 'lead_missing');
        return;
      }

      const recipients = yield* persist(() =>
        listLeadCreatedRecipients(environment, event.actorUserId),
      );
      if (recipients.length === 0) {
        skipped(event, 'no_recipients');
        return;
      }

      const providerEither = yield* Effect.either(resolver.resolve(settings));
      if (Either.isLeft(providerEither)) {
        skipped(event, providerEither.left.reason);
        return;
      }

      const provider = providerEither.right;
      const deadline = startedAt + NOTIFICATION_BUDGET_MS;
      const stop = yield* Ref.make(false);

      const sendTo = (recipient: {
        email: string;
        userId: string;
      }): Effect.Effect<RecipientOutcome> =>
        Effect.gen(function* () {
          if (yield* Ref.get(stop)) {
            return {
              kind: 'skipped',
              reason: 'uncancelable_timeout',
            } as const;
          }

          const remaining = deadline - (yield* Clock.currentTimeMillis);
          if (remaining <= 0) {
            return { kind: 'skipped', reason: 'budget_exhausted' } as const;
          }

          const sendExit = yield* Effect.exit(
            provider.send({
              deliveryKey: leadDeliveryKey(event.leadId, recipient.userId),
              envelope: buildLeadEnvelope(
                settings,
                origin,
                event.leadId,
                recipient.email,
              ),
              timeoutMs: Math.max(
                1,
                Math.min(NOTIFICATION_PROVIDER_TIMEOUT_MS, remaining),
              ),
            }),
          );
          if (Exit.isFailure(sendExit)) {
            return { kind: 'failed', reason: 'unexpected_error' } as const;
          }

          const result = sendExit.value;
          if (result.kind === 'accepted') {
            return { kind: 'accepted' } as const;
          }

          if (
            result.kind === 'ambiguous' &&
            result.reason === 'timeout' &&
            provider.policy.timeoutIsUncancelable
          ) {
            yield* Ref.set(stop, true);
          }

          return { kind: 'failed', reason: result.reason } as const;
        });

      // Effect.forEach bounds concurrency; an item only starts after the
      // previous check sees fresh remaining time, so preparation cannot
      // extend the budget.
      const outcomes = yield* Effect.forEach(recipients, sendTo, {
        concurrency: NOTIFICATION_CONCURRENCY,
      });

      let accepted = 0;
      let failed = 0;
      let budgetSkipped = 0;
      let stoppedSkipped = 0;
      let lastReason: null | string = null;
      let stopped = false;
      for (const outcome of outcomes) {
        if (outcome.kind === 'accepted') {
          accepted += 1;
        } else if (outcome.kind === 'failed') {
          failed += 1;
          lastReason = outcome.reason;
        } else if (outcome.reason === 'budget_exhausted') {
          budgetSkipped += 1;
          lastReason = outcome.reason;
        } else {
          stoppedSkipped += 1;
          stopped = true;
        }
      }

      const skippedTotal = budgetSkipped + stoppedSkipped;
      logNotificationEventOutcome({
        accepted,
        eventKind: 'lead.created',
        failed,
        leadId: event.leadId,
        outcome:
          failed > 0 ? 'failed' : skippedTotal > 0 ? 'skipped' : 'delivered',
        provider: provider.kind,
        reasonCode: stopped ? 'uncancelable_timeout' : lastReason,
        recipients: recipients.length,
        skipped: skippedTotal,
      });
    });
};
