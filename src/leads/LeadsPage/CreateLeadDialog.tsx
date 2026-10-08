import { Notice } from '@/components/Notice';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Form } from '@/components/ui/Form';
import { inputClass } from '@/components/ui/form';
import { type LeadView } from '@/domain/schemas';
import {
  emptyLeadFormValues,
  type LeadFormValues,
  toCreateLeadRequest,
} from '@/leads/leadFormValues';
import { request } from '@/lib/http';
import { useTagCatalog } from '@/tags/api';
import { TagInput } from '@/tags/TagInput';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

export const CreateLeadDialog = ({
  onOpenChange,
}: {
  readonly onOpenChange: (open: boolean) => void;
}) => {
  const queryClient = useQueryClient();
  const catalog = useTagCatalog();
  const [tagIds, setTagIds] = useState<string[]>([]);
  const catalogTags = catalog.data?.tags ?? [];
  const form = useForm<LeadFormValues>({
    defaultValues: emptyLeadFormValues,
    mode: 'onTouched',
  });
  const create = useMutation({
    mutationFn: (values: LeadFormValues) =>
      request<LeadView>('/v1/leads', {
        body: JSON.stringify({
          ...toCreateLeadRequest(values),
          // The chip draft is sent as classification names; the server
          // resolves or creates them under the same domain rules as intake.
          ...(tagIds.length
            ? {
                tags: catalogTags
                  .filter((tag) => tagIds.includes(tag.id))
                  .map((tag) => tag.label),
              }
            : {}),
        }),
        method: 'POST',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      void queryClient.invalidateQueries({ queryKey: ['tag-catalog'] });
      toast.success('Lead created');
      onOpenChange(false);
    },
  });

  return (
    <Dialog
      description="Capture the essentials. You can add more detail later."
      onOpenChange={onOpenChange}
      open
      title="New lead"
    >
      <Form
        className="lead-form"
        onChange={() => {
          const values = form.getValues();
          if (
            [values.firstName, values.lastName, values.email].some((value) =>
              value.trim(),
            )
          ) {
            form.clearErrors('firstName');
          }
        }}
        onSubmit={form.handleSubmit((values) => {
          if (
            ![values.firstName, values.lastName, values.email].some((value) =>
              value.trim(),
            )
          ) {
            form.setError(
              'firstName',
              {
                message: 'Enter a first name, last name, or email.',
                type: 'required',
              },
              { shouldFocus: true },
            );
            return;
          }

          create.mutate(values);
        })}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            error={form.formState.errors.firstName?.message}
            label="First name"
          >
            <input
              autoComplete="given-name"
              className={inputClass}
              placeholder="First name"
              {...form.register('firstName')}
            />
          </Field>
          <Field label="Last name">
            <input
              autoComplete="family-name"
              className={inputClass}
              placeholder="Last name"
              {...form.register('lastName')}
            />
          </Field>
        </div>
        <Field label="Email">
          <input
            autoComplete="email"
            className={inputClass}
            placeholder="name@company.com"
            type="email"
            {...form.register('email')}
          />
        </Field>
        <Field label="Estimated value">
          <input
            className={inputClass}
            min="0"
            placeholder="0"
            type="number"
            {...form.register('estimatedValue')}
          />
        </Field>
        {catalog.data && (
          <div className="create-tags">
            <span className="field-label">Tags</span>
            <TagInput
              label="New lead tags"
              onChange={setTagIds}
              value={tagIds}
            />
          </div>
        )}
        {create.error && <Notice error={create.error} />}
        <div className="form-footer">
          <Button
            onClick={() => onOpenChange(false)}
            tone="secondary"
          >
            Cancel
          </Button>
          <Button
            disabled={create.isPending}
            type="submit"
          >
            {create.isPending ? 'Creating…' : 'Create lead'}
          </Button>
        </div>
      </Form>
    </Dialog>
  );
};
