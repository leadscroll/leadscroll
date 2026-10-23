import { type Invite } from '../types';
import { ErrorState } from '@/components/ErrorState';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Form } from '@/components/ui/Form';
import { localTimezoneLabel, wallClockIssue } from '@/lib/datetime';
import { request } from '@/lib/http';
import {
  emptyInviteFormValues,
  type InviteFormValues,
  toCreateInviteRequest,
} from '@/lib/inviteFormValues';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

export const CreateInviteDialog = ({
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
  // is always fresh: empty name, 7-day default matching the backend, no raw
  // token, and an idle create mutation.
  const form = useForm<InviteFormValues>({
    defaultValues: emptyInviteFormValues(defaultExpiration),
    mode: 'onTouched',
  });
  const errors = form.formState.errors;
  const expiration = form.watch('expiration');
  const create = useMutation({
    mutationFn: (values: InviteFormValues) =>
      request<Invite & { token: string }>('/v1/invites', {
        body: JSON.stringify(toCreateInviteRequest(values)),
        method: 'POST',
      }),
    onSuccess: (created) => {
      // Keep the dialog open: the raw invite token is shown once and must
      // stay visible until the staff member explicitly dismisses it.
      setRawToken(created.token);
      queryClient.invalidateQueries({ queryKey: ['invites'] });
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
      title="Create invite"
    >
      {rawToken ? (
        <div className="grid gap-4">
          <p className="text-sm text-slate-300">
            Invitation created. It will not be shown again.
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
              <Copy size={16} /> Copy invite
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
            label="Invite name"
          >
            <input
              aria-invalid={errors.name ? true : undefined}
              placeholder="Weekend onboarding"
              {...form.register('name', {
                validate: (value) =>
                  Boolean(value.trim()) || 'Enter an invite name.',
              })}
            />
          </Field>
          <div className="grid gap-1">
            <Field
              error={errors.expiration?.message}
              label="Expiration"
            >
              <input
                aria-invalid={errors.expiration ? true : undefined}
                type="datetime-local"
                {...form.register('expiration', {
                  validate: (value) => wallClockIssue(value),
                })}
              />
            </Field>
            <p className="text-xs text-slate-500">
              Local time ({localTimezoneLabel(expiration)})
            </p>
          </div>
          {create.error && <ErrorState error={create.error} />}
          <div className="flex justify-end gap-2">
            <Button
              disabled={create.isPending}
              onClick={() => handleOpenChange(false)}
              tone="secondary"
              type="button"
            >
              Cancel
            </Button>
            <Button
              disabled={create.isPending}
              type="submit"
            >
              {create.isPending ? 'Creating…' : 'Create invite'}
            </Button>
          </div>
        </Form>
      )}
    </Dialog>
  );
};
