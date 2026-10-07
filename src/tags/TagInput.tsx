import { useTagCatalog } from './api';
import { TagChip } from './TagChips';
import { addTags, type Tag, tagsForIds } from './types';
import { Combobox } from '@base-ui/react/combobox';
import { Check, ChevronDown, X } from 'lucide-react';
import { useRef, useState } from 'react';

export const TagInput = ({
  catalogSelection = false,
  disabled = false,
  label = 'Tags',
  onChange,
  value,
}: {
  readonly catalogSelection?: boolean;
  readonly disabled?: boolean;
  readonly label?: string;
  readonly onChange: (ids: string[]) => void;
  readonly value: string[];
}) => {
  const catalog = useTagCatalog();
  const anchor = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const available = catalog.data?.tags ?? [];
  const selected = tagsForIds(value, available);

  return (
    <div className="tag-input-container">
      <Combobox.Root
        autoHighlight
        disabled={disabled || !catalog.data || catalog.isError}
        inputValue={search}
        isItemEqualToValue={(a: Tag, b: Tag) => a.id === b.id}
        items={available}
        itemToStringLabel={(tag: Tag) => tag.label}
        multiple
        onInputValueChange={setSearch}
        onValueChange={(next: Tag[], details) => {
          // Base UI clears a closed combobox on Escape by default. Escape here
          // dismisses search; removing assigned tags must be deliberate.
          if (details.reason === 'escape-key') {
            details.cancel();
            return;
          }

          // A catalog refresh must not silently remove unavailable draft ids.
          const unresolved = value.filter(
            (id) => !available.some((tag) => tag.id === id),
          );
          const ids = [...unresolved, ...next.map((tag) => tag.id)];
          const added = ids.filter((id) => !value.includes(id));
          const resolved = catalogSelection
            ? ids
            : addTags(ids, added, available);
          const removed = selected.filter((tag) => !resolved.includes(tag.id));
          setAnnouncement(
            removed.length
              ? `Removed ${removed.map((tag) => tag.label).join(', ')}. ${String(resolved.length)} tags selected.`
              : `${String(resolved.length)} tags selected.`,
          );
          onChange(resolved);
          setSearch('');
        }}
        openOnInputClick
        value={selected}
      >
        <Combobox.InputGroup
          className="tag-input-group"
          ref={anchor}
        >
          <Combobox.Chips
            aria-label={`Selected ${label.toLowerCase()}`}
            className="tag-input-chips"
          >
            <Combobox.Value>
              {(chosen: Tag[]) =>
                chosen.map((tag) => (
                  <Combobox.Chip
                    aria-description="Press Backspace or Delete to remove"
                    aria-label={tag.label}
                    className="tag-input-chip"
                    data-color={tag.color}
                    key={tag.id}
                  >
                    <TagChip tag={tag} />
                    <Combobox.ChipRemove
                      aria-label={`Remove ${tag.label}`}
                      className="tag-chip-remove"
                    >
                      <X size={12} />
                    </Combobox.ChipRemove>
                  </Combobox.Chip>
                ))
              }
            </Combobox.Value>
            <Combobox.Input
              aria-description={
                catalogSelection
                  ? 'Type to find tags. Use arrow keys and Enter to select available options.'
                  : 'Type to find tags. Use arrow keys and Enter to select. Selecting an exclusive tag replaces the other tag in its scope.'
              }
              aria-label={label}
              className="tag-input-search"
              placeholder="Add tags…"
            />
          </Combobox.Chips>
          <Combobox.Trigger
            aria-label={`Show ${label.toLowerCase()} options`}
            className="tag-input-trigger"
          >
            <ChevronDown size={15} />
          </Combobox.Trigger>
        </Combobox.InputGroup>
        <Combobox.Portal>
          <Combobox.Positioner
            align="start"
            anchor={anchor}
            className="tag-input-positioner"
            sideOffset={5}
          >
            <Combobox.Popup className="tag-input-popup">
              <Combobox.Empty className="tag-input-empty">
                No matching tags
              </Combobox.Empty>
              <Combobox.List className="tag-input-list">
                {(tag: Tag) => (
                  <Combobox.Item
                    className="tag-input-option"
                    key={tag.id}
                    value={tag}
                  >
                    <span className="tag-option-check">
                      <Combobox.ItemIndicator>
                        <Check size={14} />
                      </Combobox.ItemIndicator>
                    </span>
                    <TagChip tag={tag} />
                  </Combobox.Item>
                )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
      {catalog.isPending && (
        <p
          className="field-hint"
          role="status"
        >
          Loading tags…
        </p>
      )}
      {catalog.isError && (
        <p
          className="field-error"
          role="alert"
        >
          Could not load tags.{' '}
          <button
            onClick={() => {
              void catalog.refetch();
            }}
            type="button"
          >
            Retry
          </button>
        </p>
      )}
      <span
        aria-live="polite"
        className="sr-only"
        role="status"
      >
        {announcement}
      </span>
    </div>
  );
};
