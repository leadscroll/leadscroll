/**
 * Self-service new-lead email preference.
 *
 * The per-user preference row stays independent from the installation
 * document; the view reports the current availability summary only.
 */

import { type Deployment } from '@/application/deployment';
import { persist, type PersistenceError } from '@/application/errors';
import { type InstallationConfigStore } from '@/application/installation-config-store';
import { loadEmailSettingsState } from '@/application/notification-settings';
import {
  type Env,
  getNotificationPreference,
  upsertNotificationPreference,
} from '@/db/repository';
import { type NotificationPreferenceView } from '@/domain/schemas';
import { Clock, Effect } from 'effect';

export const getNotificationPreferenceView = (
  environment: Env,
  userId: string,
): Effect.Effect<
  NotificationPreferenceView,
  PersistenceError,
  Deployment | InstallationConfigStore
> =>
  Effect.gen(function* () {
    const [preference, state] = yield* Effect.all([
      persist(() => getNotificationPreference(environment, userId)),
      loadEmailSettingsState,
    ]);
    return {
      availability: state.availability,
      newLeadEmail: preference?.newLeadEmail ?? false,
      provider: state.provider,
    };
  });

export const updateNotificationPreferenceCommand = (
  environment: Env,
  userId: string,
  newLeadEmail: boolean,
) =>
  Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    yield* persist(() =>
      upsertNotificationPreference(
        environment,
        userId,
        newLeadEmail,
        new Date(nowMs),
      ),
    );
    return yield* getNotificationPreferenceView(environment, userId);
  });
