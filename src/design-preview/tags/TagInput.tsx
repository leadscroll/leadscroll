import { addTags, type Tag, tagLabel } from './model';
import { TagChip } from './TagChips';
import { tagsPreviewEnabled, useTags } from './TagProvider';
import { Combobox } from '@base-ui/react/combobox';
import { Check, ChevronDown, X } from 'lucide-react';
import { useRef, useState } from 'react';

const PreviewTagInput = ({
  catalogSelection = false,
  label = 'Tags',
  onChange,
  value,
}: {
  readonly catalogSelection?: boolean;
  readonly label?: string;
  readonly onChange: (ids: string[]) => void;
  readonly value: string[];
}) => {
  const tags = useTags();
  const anchor = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');
  const [announcement, setAnnouncement] = useState('');
  if (!tags) {
    return null;
  }

  const { state } = tags;
  const available = state.tags;
  const selected = available.filter((tag) => value.includes(tag.id));

  return (
    <div className="tag-input-container">
      <Combobox.Root
        autoHighlight
        inputValue={search}
        isItemEqualToValue={(a: Tag, b: Tag) => a.id === b.id}
        items={available}
        itemToStringLabel={(tag: Tag) => tagLabel(tag, state.groups)}
        multiple
        onInputValueChange={setSearch}
        onValueChange={(next: Tag[], details) => {
          // Base UI clears a closed combobox on Escape by default. Escape here
          // dismisses search; removing assigned tags must be deliberate.
          if (details.reason === 'escape-key') {
            details.cancel();
            return;
          }

          const ids = next.map((tag) => tag.id);
          const added = ids.filter((id) => !value.includes(id));
          const resolved = catalogSelection ? ids : addTags(ids, added, state);
          const removed = selected.filter((tag) => !resolved.includes(tag.id));
          setAnnouncement(
            removed.length
              ? `Removed ${removed.map((tag) => tagLabel(tag, state.groups)).join(', ')}. ${resolved.length} tags selected.`
              : `${resolved.length} tags selected.`,
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
                    aria-label={tagLabel(tag, state.groups)}
                    className="tag-input-chip"
                    data-color={
                      state.groups.find((group) => group.id === tag.groupId)
                        ?.color ?? tag.color
                    }
                    key={tag.id}
                  >
                    <TagChip
                      state={state}
                      tag={tag}
                    />
                    <Combobox.ChipRemove
                      aria-label={`Remove ${tagLabel(tag, state.groups)}`}
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
                    <TagChip
                      state={state}
                      tag={tag}
                    />
                  </Combobox.Item>
                )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
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

// Keep the prototype combobox out of the production bundle.
export const TagInput = tagsPreviewEnabled ? PreviewTagInput : () => null;
