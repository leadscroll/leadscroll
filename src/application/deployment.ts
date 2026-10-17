/**
 * Deployment capabilities consumed by business effects without threading the
 * raw Worker environment through every command. Composition builds this from
 * the Worker `Env`; tests can provide their own layer.
 */

import { type Env } from '@/db/repository';
import { Context, Layer } from 'effect';

export type DeploymentCapabilities = {
  readonly hasCloudflareEmailBinding: boolean;
  readonly hasCredentialEncryptionKey: boolean;
};

export class Deployment extends Context.Tag('Deployment')<
  Deployment,
  DeploymentCapabilities
>() {}

export const deploymentLayer = (environment: Env): Layer.Layer<Deployment> =>
  Layer.succeed(Deployment, {
    hasCloudflareEmailBinding: environment.EMAIL !== undefined,
    hasCredentialEncryptionKey:
      (environment.EMAIL_SETTINGS_ENCRYPTION_KEY?.trim() ?? '') !== '',
  });
