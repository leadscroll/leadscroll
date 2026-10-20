/**
 * Request-scoped and composition services used by the Effect HTTP handlers.
 *
 * The API definitions stay free of server implementation, while these
 * services let handlers yield their dependencies instead of closing over
 * mutable composition state.
 */

import { requestWaitUntil } from './execution-context';
import { type StaffContext } from './guards';
import { type Env } from '@/db/env';
import {
  createLeadCreatedPublisher,
  type LeadCreatedPublisher,
  type LeadCreatedSubscriber,
  type NotificationRuntime,
} from '@/notifications/events';
import { requestTrace } from '@/telemetry/request';
import { type TraceContext } from '@/telemetry/trace-context';
import { Context } from 'effect';

export type NotificationDispatcherShape = {
  readonly runtime: NotificationRuntime;
  readonly subscribers: readonly LeadCreatedSubscriber[];
};

export class ApiEnvironment extends Context.Service<ApiEnvironment, Env>()(
  'leadscroll/api/ApiEnvironment',
) {}

export class CurrentStaff extends Context.Service<CurrentStaff, StaffContext>()(
  'leadscroll/api/CurrentStaff',
) {}

export class NotificationDispatcher extends Context.Service<
  NotificationDispatcher,
  NotificationDispatcherShape
>()('leadscroll/api/NotificationDispatcher') {}

/**
 * Builds the request-scoped publisher after the handler has converted the
 * framework request to a Web Request. The trace ids are read from the same
 * request instance the Worker entry registered.
 */
export const publisherFor = (
  dispatcher: NotificationDispatcherShape,
  request: Request,
  trace: null | TraceContext = requestTrace(request),
): LeadCreatedPublisher =>
  createLeadCreatedPublisher({
    runtime: dispatcher.runtime,
    subscribers: dispatcher.subscribers,
    trace,
    waitUntil: (promise) => {
      const waitUntil = requestWaitUntil(request);
      if (waitUntil === null) {
        throw new Error(
          'No Worker execution context is registered for this request.',
        );
      }

      waitUntil(promise);
    },
  });
