import { useTagMutations } from './api';
import { type Tag, type TagScope } from './types';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Form } from '@/components/ui/Form';
import { inputClass } from '@/components/ui/form';
import { parseTagName } from '@/domain/tags';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

const messageOf = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : 'The request could not be completed.';

export const TagForm = ({
  initialName = '',
  onClose,
  tag,
}: {
  readonly initialName?: string;
  readonly onClose: () => void;
  readonly tag?: Tag;
}) => {
  const { createTag, renameTag } = useTagMutations();
  const form = useForm({
    defaultValues: { name: tag ? tag.label : initialName },
    mode: 'onTouched',
  });
  const parsed = parseTagName(form.watch('name'));
  const hint =
    'error' in parsed
      ? 'Use scope:value for an exclusive tag, or a plain name.'
      : parsed.prefix
        ? `Shares the ${parsed.prefix} scope’s color. Only one ${parsed.prefix}: tag per lead.`
        : 'An independent tag that can be combined with other tags.';
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      title={tag ? 'Rename tag' : 'New tag'}
    >
      <Form
        className="lead-form"
        onSubmit={form.handleSubmit(async ({ name }) => {
          try {
            if (tag) {
              await renameTag({ id: tag.id, name });
              toast.success('Tag renamed');
            } else {
              await createTag(name);
              toast.success('Tag created');
            }

            onClose();
          } catch (error) {
            form.setError(
              'name',
              { message: messageOf(error) },
              { shouldFocus: true },
            );
          }
        })}
      >
        <Field
          error={form.formState.errors.name?.message}
          label="Tag name"
        >
          <input
            className={inputClass}
            maxLength={71}
            placeholder="fall26:considering or vip"
            required
            {...form.register('name')}
          />
        </Field>
        <p className="field-hint">{hint}</p>
        <div className="form-footer">
          <Button
            onClick={onClose}
            tone="secondary"
          >
            Cancel
          </Button>
          <Button type="submit">{tag ? 'Save tag' : 'Create tag'}</Button>
        </div>
      </Form>
    </Dialog>
  );
};

export const ScopeNameForm = ({
  onClose,
  scope,
}: {
  readonly onClose: () => void;
  readonly scope: TagScope;
}) => {
  const { renameScope } = useTagMutations();
  const form = useForm({
    defaultValues: { prefix: scope.prefix },
    mode: 'onTouched',
  });
  return (
    <Dialog
      description="Updates the prefix of every tag in this scope. Assigned leads keep their tags."
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      title="Rename scope"
    >
      <Form
        className="lead-form"
        onSubmit={form.handleSubmit(async ({ prefix }) => {
          try {
            await renameScope({ id: scope.id, prefix });
            toast.success('Scope renamed');
            onClose();
          } catch (error) {
            form.setError(
              'prefix',
              { message: messageOf(error) },
              { shouldFocus: true },
            );
          }
        })}
      >
        <Field
          error={form.formState.errors.prefix?.message}
          label="Scope name"
        >
          <input
            className={inputClass}
            maxLength={30}
            required
            {...form.register('prefix')}
          />
        </Field>
        <div className="form-footer">
          <Button
            onClick={onClose}
            tone="secondary"
          >
            Cancel
          </Button>
          <Button type="submit">Save scope</Button>
        </div>
      </Form>
    </Dialog>
  );
};
