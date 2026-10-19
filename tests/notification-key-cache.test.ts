import { type EmailSettingsView } from '@/domain/schemas';
import {
  apiKeyValidationError,
  type ManageEmailFormValues,
  STORED_API_KEY_SENTINEL,
  toFormValues,
  toSaveVariables,
  toUpdateRequest,
} from '@/notifications/ManageEmailPage/saveVariables';
import {
  emailSettingsQueryKey,
  notificationPreferenceQueryKey,
  savedConfigurationTestable,
} from '@/notifications/queryKeys';
import { type MutationCache, QueryClient } from '@tanstack/react-query';
import { describe, expect, test } from 'vitest';

/**
 * The Resend API key must never enter React Query state. These tests exercise
 * the real MutationCache with the production translation helpers, so a future
 * refactor that passes form values straight into mutate() fails here rather
 * than silently retaining plaintext.
 */

const SECRET = 're_SUPER_SECRET_key_value';

const formValues = (): ManageEmailFormValues => ({
  apiKey: SECRET,
  fromEmail: 'notifications@example.test',
  fromName: 'LeadScroll',
  provider: 'resend',
  removeKey: false,
});

const buildMutation = (
  queryClient: QueryClient,
  secretReference: { current: string },
  onRequest: (value: string) => void,
) =>
  queryClient.getMutationCache().build(queryClient, {
    gcTime: 60_000,
    mutationFn: async (variables: ReturnType<typeof toSaveVariables>) => {
      const apiKey = secretReference.current;
      secretReference.current = '';
      const request = toUpdateRequest(variables, apiKey, false);
      onRequest(
        request.credential.operation === 'replace'
          ? (request.credential.value ?? '')
          : `kept:${request.credential.operation}`,
      );
      return { ok: true as const };
    },
  });

const allCacheJson = (cache: MutationCache): string =>
  JSON.stringify(
    cache.getAll().map((mutation) => ({
      data: mutation.state.data,
      error:
        mutation.state.error instanceof Error
          ? mutation.state.error.message
          : mutation.state.error,
      variables: mutation.state.variables,
    })),
  );

describe('secret-free mutation variables', () => {
  test('variables exclude the key while the request still sends it', () => {
    const values = formValues();
    const variables = toSaveVariables(values, 3);
    expect(JSON.stringify(variables)).not.toContain(SECRET);
    expect(variables.expectedRevision).toBe(3);
    expect(toUpdateRequest(variables, values.apiKey, false).credential).toEqual(
      {
        operation: 'replace',
        value: SECRET,
      },
    );
  });

  test('the key never appears in cached mutation variables after success', async () => {
    const queryClient = new QueryClient();
    const requests: string[] = [];
    const secretReference = { current: SECRET };
    const mutation = buildMutation(queryClient, secretReference, (value) => {
      requests.push(value);
    });

    await mutation.execute(toSaveVariables(formValues(), 1));
    expect(requests).toEqual([SECRET]);
    expect(secretReference.current).toBe('');
    expect(JSON.stringify(mutation.state.variables)).not.toContain(SECRET);
    expect(allCacheJson(queryClient.getMutationCache())).not.toContain(SECRET);
    expect(mutation.state.data).toEqual({ ok: true });
  });

  test('the key never appears in cached mutation state after an error', async () => {
    const queryClient = new QueryClient();
    const secretReference = { current: SECRET };
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => {
        secretReference.current = '';
        throw new Error('The request could not be completed.');
      },
    });

    await expect(
      mutation.execute(toSaveVariables(formValues(), 1)),
    ).rejects.toThrow('The request could not be completed.');
    expect(JSON.stringify(mutation.state.variables)).not.toContain(SECRET);
    expect(allCacheJson(queryClient.getMutationCache())).not.toContain(SECRET);
  });

  test('clearing the cache on unmount leaves no mutation state behind', async () => {
    const queryClient = new QueryClient();
    const secretReference = { current: SECRET };
    const mutation = buildMutation(queryClient, secretReference, () => {});
    await mutation.execute(toSaveVariables(formValues(), 1));
    queryClient.clear();
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });
});

describe('stored key sentinel', () => {
  test('an unchanged sentinel is a keep, never a credential', () => {
    const values = { ...formValues(), apiKey: STORED_API_KEY_SENTINEL };
    const variables = toSaveVariables(values, 1);
    expect(variables.apiKeyUnchanged).toBe(true);
    expect(JSON.stringify(variables)).not.toContain(SECRET);
    expect(toUpdateRequest(variables, '', true).credential).toEqual({
      operation: 'keep',
    });
  });

  test('removal is explicit and only applies to Resend', () => {
    const values = {
      ...formValues(),
      apiKey: STORED_API_KEY_SENTINEL,
      removeKey: true,
    };
    const variables = toSaveVariables(values, 1);
    expect(toUpdateRequest(variables, '', true).credential).toEqual({
      operation: 'remove',
    });
    expect(
      toUpdateRequest({ ...variables, provider: 'disabled' }, '', true)
        .credential,
    ).toEqual({ operation: 'keep' });
  });

  test('switching method keeps a stored key', () => {
    const variables = toSaveVariables(
      { ...formValues(), provider: 'cloudflare' },
      1,
    );
    expect(toUpdateRequest(variables, '', true).credential).toEqual({
      operation: 'keep',
    });
  });

  test('validation distinguishes keep, replace, empty, and partial mask', () => {
    expect(
      apiKeyValidationError(
        { ...formValues(), apiKey: STORED_API_KEY_SENTINEL },
        true,
      ),
    ).toBeNull();
    expect(
      apiKeyValidationError({ ...formValues(), apiKey: '' }, true),
    ).toContain('remove the stored key');
    expect(
      apiKeyValidationError({ ...formValues(), apiKey: '•••' }, true),
    ).toContain('leave the stored key');
    expect(apiKeyValidationError({ ...formValues(), apiKey: '' }, false)).toBe(
      'Enter the Resend API key.',
    );
    expect(
      apiKeyValidationError(
        { ...formValues(), apiKey: '', removeKey: true },
        true,
      ),
    ).toBeNull();
    expect(
      apiKeyValidationError(
        { ...formValues(), apiKey: '', provider: 'cloudflare' },
        true,
      ),
    ).toBeNull();
  });

  test('toFormValues prefills the mask only when a key is stored', () => {
    expect(
      toFormValues({
        fromEmail: null,
        fromName: null,
        hasApiKey: true,
        provider: 'resend',
      }),
    ).toMatchObject({
      apiKey: STORED_API_KEY_SENTINEL,
      removeKey: false,
    });
    expect(
      toFormValues({
        fromEmail: null,
        fromName: null,
        hasApiKey: false,
        provider: 'resend',
      }).apiKey,
    ).toBe('');
  });
});

describe('identity-scoped query keys', () => {
  test('settings and preference keys differ per user', () => {
    expect(emailSettingsQueryKey('user-a')).not.toEqual(
      emailSettingsQueryKey('user-b'),
    );
    expect(notificationPreferenceQueryKey('user-a')).not.toEqual(
      notificationPreferenceQueryKey('user-b'),
    );
  });
});

describe('saved configuration testing', () => {
  const settings = (
    overrides: Partial<EmailSettingsView>,
  ): EmailSettingsView => ({
    canonicalOrigin: 'https://crm.example.test',
    environment: { hasCloudflareBinding: true, hasEncryptionKey: true },
    fromEmail: 'notifications@example.test',
    fromName: 'LeadScroll',
    hasApiKey: true,
    provider: 'resend',
    readiness: { availability: 'disabled', reasonCode: null },
    revision: 1,
    test: null,
    ...overrides,
  });

  test('a configured method can be tested', () => {
    expect(savedConfigurationTestable(settings({}))).toEqual({ ok: true });
    expect(
      savedConfigurationTestable(
        settings({
          readiness: { availability: 'configured', reasonCode: null },
        }),
      ),
    ).toEqual({ ok: true });
  });

  test('missing local resources block testing with a specific reason', () => {
    expect(
      savedConfigurationTestable(settings({ hasApiKey: false })),
    ).toMatchObject({
      ok: false,
    });
    expect(
      savedConfigurationTestable(
        settings({
          environment: { hasCloudflareBinding: false, hasEncryptionKey: true },
          provider: 'cloudflare',
        }),
      ),
    ).toMatchObject({ message: expect.stringContaining('binding') });
    expect(
      savedConfigurationTestable(settings({ provider: 'disabled' })),
    ).toMatchObject({
      message: 'Choose a sending method before sending a test.',
      ok: false,
    });
  });
});
