import { useTagCatalog, useTagMutations } from './api';
import { TagChips } from './TagChips';
import { TagInput } from './TagInput';
import { TagPicker } from './TagPicker';
import { type Tag } from './types';
import { Button } from '@/components/ui/Button';
import { Pencil, Tags } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

const messageOf = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : 'The request could not be completed.';

export const LeadTags = ({
  assigned,
  id,
}: {
  readonly assigned: readonly Tag[];
  readonly id: string;
}) => {
  const catalog = useTagCatalog();
  const { saveLeadTags } = useTagMutations();
  const [draft, setDraft] = useState<null | string[]>(null);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
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

  const assignedIds = assigned.map((tag) => tag.id);
  const catalogTags = catalog.data?.tags ?? [];
  const save = async () => {
    if (draft === null) {
      return;
    }

    if (!catalog.data || catalog.isError) {
      setError('Tags could not be loaded. Retry loading them before saving.');
      return;
    }

    if (draft.some((tagId) => !catalogTags.some((tag) => tag.id === tagId))) {
      setError(
        'A selected tag no longer exists. Cancel and reopen the editor.',
      );
      return;
    }

    const next = draft;
    if (
      next.length === assignedIds.length &&
      next.every((tagId) => assignedIds.includes(tagId))
    ) {
      setFeedback('No changes to save.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      await saveLeadTags({ id, tagIds: next });
      setDraft(null);
      setFeedback('');
      toast.success('Tags saved');
    } catch (saveError) {
      setError(messageOf(saveError));
    } finally {
      setSaving(false);
    }
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
            setDraft([...assignedIds]);
            setFeedback('');
            setError('');
          }}
          ref={preview}
          type="button"
        >
          {assigned.length ? (
            <TagChips
              limit={assigned.length}
              tags={assigned}
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
              disabled={saving}
              label="Lead tags"
              onChange={(ids) => {
                setDraft(ids);
                setFeedback('');
                setError('');
              }}
              value={draft}
            />
            <div className="record-tag-actions">
              <Button
                disabled={saving}
                onClick={() => {
                  void save();
                }}
              >
                {saving ? 'Saving…' : 'Save tags'}
              </Button>
              <Button
                disabled={saving}
                onClick={() => {
                  setDraft(null);
                  setFeedback('');
                  setError('');
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
          {error && (
            <p
              className="field-error"
              role="alert"
            >
              {error}
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
  const { bulkTags } = useTagMutations();
  const [mode, setMode] = useState<'add' | 'remove' | null>(null);
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
          onApply={async (chosen) => {
            await bulkTags({ ids, mode, tagIds: chosen });
            toast.success(
              `Tags updated on ${String(ids.length)} lead${ids.length === 1 ? '' : 's'}`,
            );
            onApplied();
          }}
          onClose={() => setMode(null)}
          removal={mode === 'remove'}
          title={
            mode === 'remove'
              ? `Remove tags from ${String(ids.length)} leads`
              : `Add tags to ${String(ids.length)} leads`
          }
        />
      )}
    </>
  );
};
