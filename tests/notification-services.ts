/**
 * Shared test composition for notification service layers.
 *
 * Tests provide real store/deployment/cipher layers over the Miniflare D1
 * fixture and substitute either the real Cloudflare/Resend resolver or a
 * recording resolver. Business effects consume services; nothing here
 * monkeypatches globals.
 */

import { deploymentLayer } from '@/application/deployment';
import { installationConfigStoreLayer } from '@/application/installation-config-store';
import { type Env } from '@/db/repository';
import { credentialCipherLayer } from '@/notifications/credential-cipher';
import { type EmailEnvelope, type SendResult } from '@/notifications/email';
import {
  EmailProviderResolver,
  emailProviderResolverLayer,
  type EmailProviderResolverService,
  type EmailProviderService,
} from '@/notifications/email-provider';
import {
  type NotificationRuntime,
  type NotificationServices,
} from '@/notifications/events';
import { Clock, Effect, Layer, ManagedRuntime, type Result } from 'effect';

export type RecordingProvider = {
  readonly calls: SentMessage[];
  readonly provider: EmailProviderService;
};

export type RecordingProviderFactory = (
  input: SentMessage,
  call: number,
) => Effect.Effect<SendResult> | SendResult;

export type SentMessage = {
  deliveryKey: string;
  envelope: EmailEnvelope;
  timeoutMs: number;
};

const defaultResult: SendResult = {
  kind: 'accepted',
  provider: 'cloudflare',
};

export const recordingProvider = (
  result: RecordingProviderFactory | SendResult = defaultResult,
): RecordingProvider => {
  const calls: SentMessage[] = [];
  const provider: EmailProviderService = {
    kind: 'cloudflare',
    policy: { timeoutIsUncancelable: true },
    send: (input) => {
      calls.push(input);
      if (typeof result !== 'function') {
        return Effect.succeed(result);
      }

      const resolved = result(input, calls.length - 1);
      return Effect.isEffect(resolved) ? resolved : Effect.succeed(resolved);
    },
  };
  return { calls, provider };
};

export const recordingResolver = (
  provider: EmailProviderService,
): Layer.Layer<EmailProviderResolver> =>
  Layer.succeed(EmailProviderResolver, {
    resolve: () => Effect.succeed(provider),
  });

export const resolverLayer = (
  resolve: EmailProviderResolverService['resolve'],
): Layer.Layer<EmailProviderResolver> =>
  Layer.succeed(EmailProviderResolver, { resolve });

export const notificationServicesLayer = (
  environment: Env,
  resolver?: Layer.Layer<EmailProviderResolver>,
): Layer.Layer<NotificationServices> => {
  const base = Layer.mergeAll(
    installationConfigStoreLayer(environment),
    deploymentLayer(environment),
    credentialCipherLayer(environment),
  );
  const providers =
    resolver ??
    emailProviderResolverLayer(environment).pipe(Layer.provide(base));
  return Layer.merge(base, providers);
};

export const makeNotificationRuntime = (
  environment: Env,
  resolver?: Layer.Layer<EmailProviderResolver>,
  clock?: Layer.Layer<never>,
): NotificationRuntime =>
  ManagedRuntime.make(
    clock === undefined
      ? notificationServicesLayer(environment, resolver)
      : Layer.merge(notificationServicesLayer(environment, resolver), clock),
  );

export const runEither = <A, E, R extends NotificationServices>(
  runtime: NotificationRuntime,
  effect: Effect.Effect<A, E, R>,
): Promise<Result.Result<A, E>> => runtime.runPromise(Effect.result(effect));

export const runEffect = <A, E, R extends NotificationServices>(
  runtime: NotificationRuntime,
  effect: Effect.Effect<A, E, R>,
): Promise<A> => runtime.runPromise(effect);

/**
 * Test-only clock with host-controlled time. `sleep` never completes, which
 * suits tests that drive time explicitly; timeout-sensitive tests use the
 * live clock instead.
 */
export type ManualClock = {
  advance: (milliseconds: number) => void;
  readonly layer: Layer.Layer<never>;
  now: () => number;
  set: (milliseconds: number) => void;
};

export const manualClock = (startMs: number): ManualClock => {
  const state = { time: startMs };
  const clock: Clock.Clock = {
    currentTimeMillis: Effect.sync(() => state.time),
    currentTimeMillisUnsafe: () => state.time,
    currentTimeNanos: Effect.sync(() => BigInt(state.time) * 1_000_000n),
    currentTimeNanosUnsafe: () => BigInt(state.time) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(state.time) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(state.time) * 1_000_000n,
    sleep: () => Effect.never,
  };
  return {
    advance: (milliseconds) => {
      state.time += milliseconds;
    },
    layer: Layer.succeed(Clock.Clock, clock),
    now: () => state.time,
    set: (milliseconds) => {
      state.time = milliseconds;
    },
  };
};
