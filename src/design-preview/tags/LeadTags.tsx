import { addTags } from './model';
import { TagChips } from './TagChips';
import { TagInput } from './TagInput';
import { TagPicker } from './TagPicker';
import { useTags } from './TagProvider';
import { Button } from '@/components/ui/Button';
import { Pencil, Tags } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

export const LeadTags = ({ id }: { readonly id: string }) => {
  const tags = useTags();
  const [draft, setDraft] = useState<null | string[]>(null);
  const [feedback, setFeedback] = useState('');
  const editor = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const editing = draft !== null;

  useEffect(() => {
    if (editing) {
      editor.current
        ?.querySelector<HTMLInputElement>('input[role="combobox"]')
        ?.focus();
    } else if (wasEditing.current) {
      preview.current?.focus();
    }

    wasEditing.current = editing;
  }, [editing]);

  if (!tags) {
    return null;
  }

  const assigned = tags.state.assignments[id] ?? [];
  const save = () => {
    if (draft === null) {
      return;
    }

    const next = draft.filter((tagId) =>
      tags.state.tags.some((tag) => tag.id === tagId),
    );
    if (
      next.length === assigned.length &&
      next.every((tagId) => assigned.includes(tagId))
    ) {
      setFeedback('No changes to save.');
      return;
    }

    tags.setState((current) => ({
      ...current,
      assignments: { ...current.assignments, [id]: next },
    }));
    setDraft(null);
    setFeedback('');
    toast.success('Tags saved');
  };

  return (
    <div className="record-tags">
      <span className="record-tags-label">
        <Tags size={13} /> Tags
      </span>
      {draft === null ? (
        <button
          aria-label="Edit lead tags"
          className="record-tags-preview"
          onClick={() => {
            setDraft([...assigned]);
            setFeedback('');
          }}
          ref={preview}
          type="button"
        >
          {assigned.length ? (
            <TagChips
              ids={assigned}
              limit={tags.state.tags.length}
            />
          ) : (
            <span className="text-muted">Add tags…</span>
          )}
          <Pencil
            aria-hidden="true"
            className="record-tags-edit-icon"
            size={14}
          />
        </button>
      ) : (
        <div
          className="record-tags-edit-area"
          ref={editor}
        >
          <div className="record-tags-editor">
            <TagInput
              label="Lead tags"
              onChange={(ids) => {
                setDraft(ids);
                setFeedback('');
              }}
              value={draft}
            />
            <div className="record-tag-actions">
              <Button onClick={save}>Save tags</Button>
              <Button
                onClick={() => {
                  setDraft(null);
                  setFeedback('');
                }}
                tone="ghost"
              >
                Cancel
              </Button>
            </div>
          </div>
          {feedback && (
            <p
              className="field-hint"
              role="status"
            >
              {feedback}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export const BulkTags = ({
  ids,
  onApplied,
}: {
  readonly ids: string[];
  readonly onApplied: () => void;
}) => {
  const tags = useTags();
  const [mode, setMode] = useState<'add' | 'remove' | null>(null);
  if (!tags) {
    return null;
  }

  return (
    <>
      <Button
        onClick={() => setMode('add')}
        tone="secondary"
      >
        <Tags size={14} /> Add tags
      </Button>
      <Button
        onClick={() => setMode('remove')}
        tone="ghost"
      >
        Remove tags
      </Button>
      {mode && (
        <TagPicker
          initial={[]}
          onApply={(chosen) => {
            tags.setState((current) => ({
              ...current,
              assignments: {
                ...current.assignments,
                ...Object.fromEntries(
                  ids.map((id) => [
                    id,
                    mode === 'remove'
                      ? (current.assignments[id] ?? []).filter(
                          (tag) => !chosen.includes(tag),
                        )
                      : addTags(current.assignments[id] ?? [], chosen, current),
                  ]),
                ),
              },
            }));
            toast.success(`Tags updated on ${ids.length} leads`);
            onApplied();
          }}
          onClose={() => setMode(null)}
          removal={mode === 'remove'}
          title={
            mode === 'remove'
              ? `Remove tags from ${ids.length} leads`
              : `Add tags to ${ids.length} leads`
          }
        />
      )}
    </>
  );
};
