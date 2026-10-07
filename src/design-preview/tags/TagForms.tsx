import { parseTagName, renameCatalogScope, saveCatalogTag } from './catalog';
import { type Tag, type TagGroup, tagLabel } from './model';
import { useTags } from './TagProvider';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Form } from '@/components/ui/Form';
import { inputClass } from '@/components/ui/form';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

export const TagForm = ({
  initialName = '',
  onClose,
  tag,
}: {
  readonly initialName?: string;
  readonly onClose: () => void;
  readonly tag?: Tag;
}) => {
  const tags = useTags();
  const form = useForm({
    defaultValues: {
      name: tag && tags ? tagLabel(tag, tags.state.groups) : initialName,
    },
    mode: 'onTouched',
  });
  const parsed = parseTagName(form.watch('name'));
  if (!tags) {
    return null;
  }

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
        onSubmit={form.handleSubmit(({ name }) => {
          const result = saveCatalogTag(tags.state, name, tag?.id);
          if ('error' in result) {
            form.setError(
              'name',
              { message: result.error },
              { shouldFocus: true },
            );
            return;
          }

          tags.setState(result.state);
          toast.success(tag ? 'Tag renamed' : 'Tag created');
          onClose();
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
  group,
  onClose,
}: {
  readonly group: TagGroup;
  readonly onClose: () => void;
}) => {
  const tags = useTags();
  const form = useForm({
    defaultValues: { prefix: group.prefix },
    mode: 'onTouched',
  });
  if (!tags) {
    return null;
  }

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
        onSubmit={form.handleSubmit(({ prefix }) => {
          const result = renameCatalogScope(tags.state, group.id, prefix);
          if ('error' in result) {
            form.setError(
              'prefix',
              { message: result.error },
              { shouldFocus: true },
            );
            return;
          }

          tags.setState(result.state);
          toast.success('Scope renamed');
          onClose();
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
