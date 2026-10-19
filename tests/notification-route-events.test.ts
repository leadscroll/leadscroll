import {
  type NotificationFixture,
  startNotificationFixture,
} from './notification-fixture';
import { createApp } from '@/api/app';
import { registerRequestWaitUntil } from '@/api/execution-context';
import { createApiToken } from '@/db/repository';
import { type LeadCreatedEvent } from '@/notifications/events';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const ORIGIN = 'https://route-events.example';
const ADMIN_EMAIL = 'notify-admin@example.test';
const ADMIN_ID = 'route-events-admin';

let fixture: NotificationFixture;

beforeEach(async () => {
  if (fixture !== undefined) {
    await fixture.dispose();
  }

  // The hook runs serially; the rule cannot see that.
  // eslint-disable-next-line require-atomic-updates
  fixture = await startNotificationFixture();
  await fixture.user({ email: ADMIN_EMAIL, id: ADMIN_ID });
});

afterEach(async () => {
  await fixture.dispose();
});

/**
 * Exercises the real HTTP composition and the per-request execution-context
 * registration: every lead-creating route must hand the publisher the
 * request-scoped waitUntil, and replays must not publish a second event.
 */
const buildApp = (events: LeadCreatedEvent[]) =>
  createApp(fixture.env, {
    notificationSubscribers: [
      (event: LeadCreatedEvent) =>
        Effect.sync(() => {
          events.push(event);
        }),
    ],
  });

const dispatch = async (
  app: ReturnType<typeof buildApp>,
  request: Request,
): Promise<{ pending: Array<Promise<unknown>>; response: Response }> => {
  const pending: Array<Promise<unknown>> = [];
  registerRequestWaitUntil(request, (promise) => {
    pending.push(promise);
  });
  const response = await app.handle(request);
  await Promise.allSettled(pending);
  return { pending, response };
};

const jsonRequest = (
  path: string,
  init: { body: unknown; headers?: Record<string, string>; method: string },
): Request =>
  new Request(`${ORIGIN}${path}`, {
    body: JSON.stringify(init.body),
    headers: {
      'Content-Type': 'application/json',
      ...(init.method === 'POST' ? { Origin: ORIGIN } : {}),
      ...init.headers,
    },
    method: init.method,
  });

describe('lead-creating route event wiring', () => {
  test('manual creation publishes through the request execution context', async () => {
    const events: LeadCreatedEvent[] = [];
    const app = buildApp(events);

    const { pending, response } = await dispatch(
      app,
      jsonRequest('/v1/leads', {
        body: { email: 'route-manual@example.test' },
        method: 'POST',
      }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: { id: string } };
    expect(pending).toHaveLength(1);
    expect(events).toEqual([{ actorUserId: ADMIN_ID, leadId: body.data.id }]);
  });

  test('authenticated intake publishes once and never on replay', async () => {
    const events: LeadCreatedEvent[] = [];
    const app = buildApp(events);
    const token = await createApiToken(fixture.env, {
      name: 'Route intake',
      type: 'api',
    });

    const send = () =>
      dispatch(
        app,
        jsonRequest('/v1/intakes', {
          body: { email: 'route-intake@example.test', source: 'Route test' },
          headers: {
            Authorization: `Bearer ${token.token}`,
            'Idempotency-Key': 'route-intake-key-1',
          },
          method: 'POST',
        }),
      );

    const first = await send();
    expect(first.response.status).toBe(201);
    expect(first.pending).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0].actorUserId).toBeNull();

    const replay = await send();
    expect(replay.response.status).toBe(201);
    expect(replay.pending).toHaveLength(0);
    expect(events).toHaveLength(1);
  });

  test('public intake publishes once and never on replay', async () => {
    const events: LeadCreatedEvent[] = [];
    const app = buildApp(events);
    const token = await createApiToken(fixture.env, {
      name: 'Route public intake',
      type: 'browser',
    });

    const send = () =>
      dispatch(
        app,
        new Request(
          `${ORIGIN}/v1/public/intakes/${encodeURIComponent(token.token)}`,
          {
            body: JSON.stringify({
              email: 'route-public@example.test',
              source: 'Route test',
            }),
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Key': 'route-public-key-1',
            },
            method: 'POST',
          },
        ),
      );

    const first = await send();
    expect(first.response.status).toBe(201);
    expect(first.pending).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0].actorUserId).toBeNull();

    const replay = await send();
    expect(replay.response.status).toBe(201);
    expect(replay.pending).toHaveLength(0);
    expect(events).toHaveLength(1);
  });
});
