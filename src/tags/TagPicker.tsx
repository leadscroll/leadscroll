import { TagInput } from './TagInput';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { useRef, useState } from 'react';

// Bulk operations stage their selection; everyday editing uses TagInput directly.
export const TagPicker = ({
  initial,
  onApply,
  onClose,
  removal = false,
  title = 'Edit tags',
}: {
  readonly initial: string[];
  readonly onApply: (ids: string[]) => Promise<void>;
  readonly onClose: () => void;
  readonly removal?: boolean;
  readonly title?: string;
}) => {
  const [selected, setSelected] = useState(initial);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const inputContainer = useRef<HTMLDivElement>(null);
  return (
    <Dialog
      description={
        removal
          ? 'Only the selected tags will be removed.'
          : 'Tags in the same exclusive scope will be replaced.'
      }
      onOpenChange={(open) => {
        if (!open && !pending) {
          onClose();
        }
      }}
      open
      title={title}
    >
      <div ref={inputContainer}>
        <TagInput
          catalogSelection={removal}
          disabled={pending}
          label={removal ? 'Tags to remove' : 'Tags to add'}
          onChange={(ids) => {
            setSelected(ids);
            setError('');
          }}
          value={selected}
        />
        {error && (
          <p
            className="field-error"
            role="alert"
          >
            {error}
          </p>
        )}
      </div>
      <div className="form-footer">
        <Button
          disabled={pending}
          onClick={onClose}
          tone="secondary"
        >
          Cancel
        </Button>
        <Button
          disabled={pending}
          onClick={() => {
            if (!selected.length) {
              setError('Choose at least one tag.');
              inputContainer.current?.querySelector('input')?.focus();
              return;
            }

            setPending(true);
            setError('');
            void (async () => {
              try {
                await onApply(selected);
                onClose();
              } catch (saveError) {
                setError(
                  saveError instanceof Error
                    ? saveError.message
                    : 'Tags could not be saved. Try again.',
                );
              } finally {
                setPending(false);
              }
            })();
          }}
        >
          {pending ? 'Applying…' : 'Apply tags'}
        </Button>
      </div>
    </Dialog>
  );
};
