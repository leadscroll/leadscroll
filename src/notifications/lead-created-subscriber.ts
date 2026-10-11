/**
 * Best-effort email subscriber for the `lead.created` event.
 *
 * Reads the current installation configuration and the current opted-in,
 * enabled staff, excludes the manual creator, verifies the lead still exists,
 * and sends one generic message per recipient through the saved provider. It
 * never falls back to another provider and never touches a provider while the
 * installation is disabled, misconfigured, or has no recipients.
 *
 * Work is bounded by a small concurrency limit and a background budget below
 * the Worker runtime window; each provider call gets the smaller of its own
 * timeout and the remaining budget. The budget clock starts when the event
 * reaches the subscriber, so configuration, lead, and recipient reads and
 * credential decryption all consume it. Those reads are D1/WebCrypto work that
 * cannot be canceled; a stalled preparation phase therefore exhausts the
 * budget before any send, and the first per-send check reports the remaining
 * recipients as skipped instead of launching work. If the budget runs out, the
 * remaining recipients are reported as skipped rather than silently dropped.
 * A Cloudflare timeout stops new sends for that event (already-running native
 * binding calls cannot be canceled and may still finish); the unsent
 * recipients are counted in the skipped total. There is no retry, replay, or
 * durable delivery state: an interrupted or rejected send is lost, and a
 * timeout is reported as unknown and left alone.
 */

import { logNotificationEventOutcome } from '@/api/logging';
import {
  createSenderFromState,
  loadEmailSettingsState,
  senderFailureReason,
  type SenderOverrides,
} from '@/application/notification-commands';
import {
  type EmailSettingsRecord,
  type Env,
  getLead,
  listLeadCreatedRecipients,
} from '@/db/repository';
import {
  type EmailEnvelope,
  type EmailSender,
  leadDeliveryKey,
  type SendResult,
} from '@/notifications/email';
import {
  type LeadCreatedEvent,
  type LeadCreatedSubscriber,
} from '@/notifications/events';
import { renderNewLeadNotification } from '@/notifications/templates';

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

export type LeadCreatedSubscriberOverrides = SenderOverrides & {
  budgetMs?: number;
  concurrency?: number;
  now?: () => Date;
  providerTimeoutMs?: number;
};

const buildLeadEnvelope = (
  settings: EmailSettingsRecord,
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

export const createLeadCreatedEmailSubscriber = (
  overrides: LeadCreatedSubscriberOverrides = {},
): LeadCreatedSubscriber => {
  const now = overrides.now ?? (() => new Date());
  return async (environment: Env, event: LeadCreatedEvent) => {
    // The overall budget starts here, before configuration/lead/recipient
    // reads and credential decryption, so preparation cannot extend it.
    const budgetMs = overrides.budgetMs ?? NOTIFICATION_BUDGET_MS;
    const startedAt = now().getTime();
    const state = await loadEmailSettingsState(environment);
    const settings = state.settings;
    if (
      settings === null ||
      settings.provider === 'disabled' ||
      !settings.enabled
    ) {
      logNotificationEventOutcome({
        eventKind: 'lead.created',
        leadId: event.leadId,
        outcome: 'skipped',
        reasonCode:
          settings !== null && settings.provider === 'disabled'
            ? 'disabled'
            : 'not_configured',
      });
      return;
    }

    if (state.availability !== 'configured') {
      logNotificationEventOutcome({
        eventKind: 'lead.created',
        leadId: event.leadId,
        outcome: 'skipped',
        reasonCode: state.readinessReason ?? 'not_configured',
      });
      return;
    }

    const origin = settings.canonicalOrigin;
    if (origin === null || origin.trim().length === 0) {
      logNotificationEventOutcome({
        eventKind: 'lead.created',
        leadId: event.leadId,
        outcome: 'skipped',
        reasonCode: 'canonical_origin_missing',
      });
      return;
    }

    const lead = await getLead(environment, event.leadId);
    if (lead === null || lead.deletedAt !== null) {
      logNotificationEventOutcome({
        eventKind: 'lead.created',
        leadId: event.leadId,
        outcome: 'skipped',
        reasonCode: 'lead_missing',
      });
      return;
    }

    const recipients = await listLeadCreatedRecipients(
      environment,
      event.actorUserId,
    );
    if (recipients.length === 0) {
      logNotificationEventOutcome({
        eventKind: 'lead.created',
        leadId: event.leadId,
        outcome: 'skipped',
        reasonCode: 'no_recipients',
      });
      return;
    }

    let sender: EmailSender;
    try {
      sender = await createSenderFromState(environment, state, overrides);
    } catch (error) {
      logNotificationEventOutcome({
        eventKind: 'lead.created',
        leadId: event.leadId,
        outcome: 'skipped',
        reasonCode: senderFailureReason(error),
      });
      return;
    }

    const deadline = startedAt + budgetMs;
    const concurrency = Math.max(
      1,
      Math.min(
        overrides.concurrency ?? NOTIFICATION_CONCURRENCY,
        recipients.length,
      ),
    );
    let cursor = 0;
    let accepted = 0;
    let failed = 0;
    let skipped = 0;
    let lastReason: null | string = null;
    // A native Cloudflare timeout leaves the binding call running and cannot
    // be canceled, so stop launching new recipients for this event; the
    // already-running calls finish and the remaining recipients are counted.
    const stop = { cloudflareTimedOut: false };
    let unsent = 0;
    const providerTimeoutMs =
      overrides.providerTimeoutMs ?? NOTIFICATION_PROVIDER_TIMEOUT_MS;

    const sendTo = async (recipient: {
      email: string;
      userId: string;
    }): Promise<void> => {
      if (stop.cloudflareTimedOut) {
        unsent += 1;
        return;
      }

      const remaining = deadline - now().getTime();
      if (remaining <= 0) {
        skipped += 1;
        lastReason = 'budget_exhausted';
        return;
      }

      const envelope = buildLeadEnvelope(
        settings,
        origin,
        event.leadId,
        recipient.email,
      );
      let result: SendResult;
      try {
        result = await sender.send(envelope, {
          deliveryKey: leadDeliveryKey(event.leadId, recipient.userId),
          timeoutMs: Math.max(1, Math.min(providerTimeoutMs, remaining)),
        });
      } catch {
        result = {
          kind: 'ambiguous',
          provider: sender.provider,
          reason: 'unexpected_error',
        };
      }

      if (result.kind === 'accepted') {
        accepted += 1;
      } else {
        failed += 1;
        lastReason = result.reason;
        if (sender.provider === 'cloudflare' && result.reason === 'timeout') {
          // Shared by lanes in one single-threaded subscriber run; the rule's
          // stale-read warning does not apply to this flag across awaits.
          // eslint-disable-next-line require-atomic-updates
          stop.cloudflareTimedOut = true;
        }
      }
    };

    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= recipients.length) {
            return;
          }

          await sendTo(recipients[index]);
        }
      }),
    );

    const skippedTotal = skipped + unsent;
    logNotificationEventOutcome({
      accepted,
      eventKind: 'lead.created',
      failed,
      leadId: event.leadId,
      outcome:
        failed > 0 ? 'failed' : skippedTotal > 0 ? 'skipped' : 'delivered',
      provider: sender.provider,
      reasonCode: stop.cloudflareTimedOut ? 'cloudflare_timeout' : lastReason,
      recipients: recipients.length,
      skipped: skippedTotal,
    });
  };
};
