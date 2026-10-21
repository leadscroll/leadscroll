import {
  type NotificationFixture,
  startNotificationFixture,
} from './notification-fixture';
import { makeNotificationRuntime } from './notification-services';
import { createIntakeCommand, createLeadCommand } from '@/application/commands';
import { type IntakeRequest } from '@/domain/schemas';
import {
  createLeadCreatedPublisher,
  type LeadCreatedEvent,
  type LeadCreatedPublisher,
  runLeadCreatedSubscribers,
} from '@/notifications/events';
import { Effect, Result } from 'effect';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let fixture: NotificationFixture;

beforeEach(async () => {
  if (fixture !== undefined) {
    await fixture.dispose();
  }

  // The hook runs serially; the rule cannot see that.
  // eslint-disable-next-line require-atomic-updates
  fixture = await startNotificationFixture();
});

afterEach(async () => {
  await fixture.dispose();
  vi.restoreAllMocks();
});

const intakeInput = (email: string): IntakeRequest => ({
  email,
  source: 'Test intake',
});

const event = (leadId = '01ARZ3NDEKTSV4RRFFQ69G5FAV'): LeadCreatedEvent => ({
  actorUserId: null,
  leadId,
});

const recordingPublisher = (): LeadCreatedPublisher & {
  events: LeadCreatedEvent[];
} => {
  const events: LeadCreatedEvent[] = [];
  return {
    events,
    publishLeadCreated: (published) => {
      events.push(published);
    },
  };
};

describe('lead.created publication', () => {
  test('manual creation publishes one event for the committed lead', async () => {
    const events = recordingPublisher();
    const lead = await Effect.runPromise(
      createLeadCommand(
        fixture.env,
        { email: 'manual@example.test' },
        'actor-user-1',
        events,
      ),
    );

    expect(events.events).toEqual([
      { actorUserId: 'actor-user-1', leadId: lead.id },
    ]);
  });

  test('validation failure publishes nothing', async () => {
    const events = recordingPublisher();
    const outcome = await Effect.runPromise(
      Effect.result(createLeadCommand(fixture.env, {}, 'actor-user-1', events)),
    );

    expect(Result.isFailure(outcome)).toBe(true);
    expect(events.events).toHaveLength(0);
    expect(await fixture.count('leads')).toBe(0);
  });

  test('intake publishes once; replay and conflict publish nothing', async () => {
    const events = recordingPublisher();
    const input = intakeInput('intake@example.test');

    const first = await Effect.runPromise(
      createIntakeCommand(
        fixture.env,
        input,
        'intake-key-1',
        undefined,
        undefined,
        events,
      ),
    );
    expect(first.kind).toBe('created');
    expect(events.events).toHaveLength(1);

    const replay = await Effect.runPromise(
      createIntakeCommand(
        fixture.env,
        input,
        'intake-key-1',
        undefined,
        undefined,
        events,
      ),
    );
    expect(replay.kind).toBe('replayed');
    expect(events.events).toHaveLength(1);

    const conflict = await Effect.runPromise(
      createIntakeCommand(
        fixture.env,
        intakeInput('different@example.test'),
        'intake-key-1',
        undefined,
        undefined,
        events,
      ),
    );
    expect(conflict.kind).toBe('conflict');
    expect(events.events).toHaveLength(1);
  });

  test('concurrent same-key intake produces one lead and one event', async () => {
    const events = recordingPublisher();
    const input = intakeInput('concurrent@example.test');

    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        Effect.runPromise(
          createIntakeCommand(
            fixture.env,
            input,
            'intake-key-concurrent',
            undefined,
            undefined,
            events,
          ),
        ),
      ),
    );

    expect(results.filter((result) => result.kind === 'created')).toHaveLength(
      1,
    );
    expect(events.events).toHaveLength(1);
    expect(await fixture.count('leads')).toBe(1);
  });

  test('events from concurrent requests stay associated with their own lead', async () => {
    const firstEvents = recordingPublisher();
    const secondEvents = recordingPublisher();

    const [first, second] = await Promise.all([
      Effect.runPromise(
        createLeadCommand(
          fixture.env,
          { email: 'first@example.test' },
          'actor-1',
          firstEvents,
        ),
      ),
      Effect.runPromise(
        createLeadCommand(
          fixture.env,
          { email: 'second@example.test' },
          'actor-2',
          secondEvents,
        ),
      ),
    ]);

    expect(firstEvents.events).toEqual([
      { actorUserId: 'actor-1', leadId: first.id },
    ]);
    expect(secondEvents.events).toEqual([
      { actorUserId: 'actor-2', leadId: second.id },
    ]);
  });
});

describe('subscriber isolation', () => {
  test('failing subscribers do not stop other subscribers', async () => {
    const runtime = makeNotificationRuntime(fixture.env);
    const completed: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runLeadCreatedSubscribers(
      runtime,
      [
        () => {
          throw new Error('construction sentinel');
        },
        () => Effect.die(new Error('defect sentinel')),
        () => Effect.fail(new Error('typed sentinel')),
        () =>
          Effect.sync(() => {
            completed.push('third');
          }),
      ],
      event(),
    );

    expect(completed).toEqual(['third']);
    expect(errorSpy).toHaveBeenCalledTimes(3);
    const classes = errorSpy.mock.calls.map(
      (call) =>
        (JSON.parse(String(call[0])) as Record<string, unknown>).errorClass,
    );
    expect(classes.toSorted()).toEqual(['Defect', 'Defect', 'Error']);
    for (const call of errorSpy.mock.calls) {
      const line = JSON.parse(String(call[0])) as Record<string, unknown>;
      expect(line).toEqual({
        errorClass: line.errorClass,
        event: 'notification.event',
        eventKind: 'lead.created',
        leadId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        outcome: 'subscriber_failed',
      });
      expect(String(call[0])).not.toContain('sentinel');
    }
  });

  test('a scheduling failure is logged and never thrown at the caller', async () => {
    const runtime = makeNotificationRuntime(fixture.env);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const publisher = createLeadCreatedPublisher({
      runtime,
      subscribers: [],
      waitUntil: () => {
        throw new Error('execution context unavailable');
      },
    });

    expect(() => publisher.publishLeadCreated(event())).not.toThrow();
    const line = JSON.parse(String(errorSpy.mock.calls[0]?.[0])) as Record<
      string,
      unknown
    >;
    expect(line).toMatchObject({
      errorClass: 'Error',
      event: 'notification.event',
      outcome: 'scheduling_failed',
    });
    expect(String(errorSpy.mock.calls[0]?.[0])).not.toContain(
      'execution context unavailable',
    );
  });

  test('publish hands the real subscriber promise to waitUntil', async () => {
    const runtime = makeNotificationRuntime(fixture.env);
    const scheduled: Array<Promise<unknown>> = [];
    const seen: LeadCreatedEvent[] = [];
    const publisher = createLeadCreatedPublisher({
      runtime,
      subscribers: [
        (published) =>
          Effect.sync(() => {
            seen.push(published);
          }),
      ],
      waitUntil: (promise) => {
        scheduled.push(promise);
      },
    });

    publisher.publishLeadCreated(event());
    expect(seen).toHaveLength(0);
    expect(scheduled).toHaveLength(1);
    await scheduled[0];
    expect(seen).toEqual([event()]);
  });
});
