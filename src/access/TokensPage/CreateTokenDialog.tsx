import { type Token } from '../types';
import { ErrorState } from '@/components/ErrorState';
import { TokenExpirationField } from '@/components/TokenExpirationField';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Form } from '@/components/ui/Form';
import { request } from '@/lib/http';
import {
  emptyTokenFormValues,
  toCreateTokenRequest,
  type TokenFormValues,
} from '@/lib/tokenFormValues';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

export const CreateTokenDialog = ({
  defaultExpiration,
  onOpenChange,
  open,
}: {
  readonly defaultExpiration: string;
  readonly onOpenChange: (value: boolean) => void;
  readonly open: boolean;
}) => {
  const queryClient = useQueryClient();
  const [copyFailed, setCopyFailed] = useState(false);
  const [rawToken, setRawToken] = useState<null | string>(null);
  // The parent remounts this dialog (via its key) on every open, so the form
  // is always fresh: empty name, 90-day default matching the backend, no raw
  // token, and an idle create mutation.
  const form = useForm<TokenFormValues>({
    defaultValues: emptyTokenFormValues(defaultExpiration),
    mode: 'onTouched',
  });
  const errors = form.formState.errors;
  const [expirationReference, setExpirationReference] = useState(Date.now);
  const tokenType = form.watch('type');
  const create = useMutation({
    mutationFn: (values: TokenFormValues) =>
      request<Token & { token: string }>('/v1/tokens', {
        body: JSON.stringify(toCreateTokenRequest(values, expirationReference)),
        method: 'POST',
      }),
    onSuccess: (created) => {
      // Keep the dialog open: the raw token is shown once and must stay
      // visible until the staff member explicitly dismisses it.
      setRawToken(created.token);
      queryClient.invalidateQueries({ queryKey: ['tokens'] });
    },
  });

  // Escape, backdrop, and the close control all route through here. While a
  // create is in flight, dismissal is ignored so a generated token can never
  // be lost behind a closed dialog.
  const handleOpenChange = (value: boolean) => {
    if (!value && create.isPending) {
      return;
    }

    onOpenChange(value);
  };

  const copyToken = async () => {
    if (!rawToken) {
      return;
    }

    try {
      await navigator.clipboard.writeText(rawToken);
      setCopyFailed(false);
    } catch {
      // Clipboard access can be denied; the raw text stays visible and
      // selectable instead of being replaced by a "copied" state.
      setCopyFailed(true);
    }
  };

  return (
    <Dialog
      onOpenChange={handleOpenChange}
      open={open}
      title="Create token"
    >
      {rawToken ? (
        <div className="grid gap-4">
          <p className="text-sm text-slate-300">
            {tokenType === 'browser'
              ? 'Browser token created. It is stored, so you can copy it again from the list.'
              : 'Token created. It will not be shown again.'}
          </p>
          <code className="block break-all rounded-md border border-slate-700 bg-slate-950 p-3 font-mono text-xs text-slate-100">
            {rawToken}
          </code>
          {copyFailed && (
            <p className="text-sm text-amber-300">
              Clipboard unavailable — select the text above to copy it.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => {
                void copyToken();
              }}
            >
              Copy token
            </Button>
            <Button
              onClick={() => handleOpenChange(false)}
              tone="secondary"
            >
              Done
            </Button>
          </div>
        </div>
      ) : (
        <Form
          className="grid gap-4"
          onSubmit={form.handleSubmit((values) => {
            create.mutate(values);
          })}
        >
          <Field
            error={errors.name?.message}
            label="Token name"
          >
            <input
              aria-invalid={errors.name ? true : undefined}
              placeholder="Website form intake"
              {...form.register('name', {
                validate: (value) =>
                  Boolean(value.trim()) || 'Enter a token name.',
              })}
            />
          </Field>
          <div className="grid gap-1">
            <label className="grid gap-1 text-sm text-slate-300">
              Token type
              <select {...form.register('type')}>
                <option value="api">API — server integrations</option>
                <option value="browser">Browser — website forms</option>
              </select>
            </label>
            <p className="text-xs text-slate-500">
              {tokenType === 'browser'
                ? 'Safe to embed in a website; it can only create leads.'
                : 'Keep it secret; it can call the integration API.'}
            </p>
          </div>
          <TokenExpirationField
            form={form}
            onPresetChange={() => setExpirationReference(Date.now())}
            referenceTime={expirationReference}
          />
          {create.error && <ErrorState error={create.error} />}
          <div className="flex justify-end gap-2">
            <Button
              disabled={create.isPending}
              onClick={() => handleOpenChange(false)}
              tone="secondary"
            >
              Cancel
            </Button>
            <Button
              disabled={create.isPending}
              type="submit"
            >
              {create.isPending ? 'Creating…' : 'Create token'}
            </Button>
          </div>
        </Form>
      )}
    </Dialog>
  );
};
