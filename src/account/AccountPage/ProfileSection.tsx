import {
  type AccountProfileFormValues,
  toUpdateAccountProfileRequest,
} from '@/account/accountFormValues';
import { Notice } from '@/components/Notice';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Form } from '@/components/ui/Form';
import { inputClass } from '@/components/ui/form';
import { updateUser, useSession } from '@/lib/auth-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

export const ProfileSection = ({
  email,
  name,
  updatedAt,
}: {
  readonly email: string;
  readonly name: string;
  readonly updatedAt: Date;
}) => {
  const { refetch } = useSession();
  const queryClient = useQueryClient();
  const {
    formState: { errors, isDirty, isSubmitting },
    handleSubmit,
    register,
    reset,
  } = useForm<AccountProfileFormValues>({
    defaultValues: { name },
    mode: 'onTouched',
  });
  const submitLock = useRef(false);
  const releaseSubmit = () => {
    submitLock.current = false;
  };

  const newestRevision = useRef(updatedAt.getTime());
  const acceptedName = useRef<null | {
    name: string;
    previousRevision: number;
  }>(null);
  const [feedback, setFeedback] = useState('');
  useEffect(() => {
    const revision = updatedAt.getTime();
    if (
      revision < newestRevision.current ||
      (acceptedName.current !== null &&
        name !== acceptedName.current.name &&
        revision <= acceptedName.current.previousRevision)
    ) {
      return;
    }

    newestRevision.current = revision;
    acceptedName.current = null;
    if (!isDirty) {
      reset({ name });
    }
  }, [isDirty, name, reset, updatedAt]);

  const save = useMutation({
    mutationFn: async (input: AccountProfileFormValues) => {
      const { error } = await updateUser(input);
      if (error) {
        throw new Error(error.message ?? 'The name could not be saved.');
      }
    },
    onSuccess: async (_, input) => {
      acceptedName.current = {
        name: input.name,
        previousRevision: newestRevision.current,
      };
      reset(input);
      await Promise.all([
        refetch(),
        queryClient.invalidateQueries({ queryKey: ['staff'] }),
      ]);
      toast.success('Name updated');
    },
  });
  const pending = save.isPending || isSubmitting;
  return (
    <section className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/40 p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
        Profile
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        Your display name appears in the staff list. Activity history uses your
        email.
      </p>
      <Form
        className="mt-4 grid gap-4"
        onChange={() => setFeedback('')}
        onSubmit={(event) => {
          void handleSubmit(async (values) => {
            if (submitLock.current || pending) {
              return;
            }

            if (values.name.trim() === (acceptedName.current?.name ?? name)) {
              setFeedback('No changes to save.');
              return;
            }

            setFeedback('');

            submitLock.current = true;
            try {
              await save.mutateAsync(toUpdateAccountProfileRequest(values));
            } catch {
              /* Mutation error is displayed below. */
            } finally {
              releaseSubmit();
            }
          })(event);
        }}
      >
        <Field
          error={errors.name?.message}
          hint="1–200 characters"
          label="Name"
        >
          <input
            className={inputClass}
            disabled={pending}
            required
            {...register('name', {
              validate: (value) =>
                (value.trim().length > 0 && value.trim().length <= 200) ||
                'Enter a name of 1–200 characters.',
            })}
          />
        </Field>
        <Field
          hint="Email changes are unavailable on this installation. A replacement invited account does not transfer your history."
          label="Email"
        >
          <input
            className={`${inputClass} cursor-not-allowed opacity-60`}
            readOnly
            value={email}
          />
        </Field>
        {save.error && <Notice error={save.error} />}
        {feedback && (
          <p
            className="field-hint"
            role="status"
          >
            {feedback}
          </p>
        )}
        <div>
          <Button
            disabled={pending}
            type="submit"
          >
            {pending ? 'Saving…' : 'Save name'}
          </Button>
        </div>
      </Form>
    </section>
  );
};
