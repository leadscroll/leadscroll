import { tagLabel, type TagState } from './model';
import { useTags } from './TagProvider';
import { X } from 'lucide-react';

export const matchesTagFilter = (
  id: string,
  filter: string,
  state: TagState,
): boolean => {
  const assigned = state.assignments[id] ?? [];
  if (filter.startsWith('group:')) {
    return state.tags.some(
      (tag) => tag.groupId === filter.slice(6) && assigned.includes(tag.id),
    );
  }

  if (filter.startsWith('tag:')) {
    return assigned.includes(filter.slice(4));
  }

  return true;
};

export const TagFilter = ({
  onChange,
  value,
}: {
  readonly onChange: (value: string) => void;
  readonly value: string;
}) => {
  const tags = useTags();
  if (!tags) {
    return null;
  }

  return (
    <div className="tag-filter">
      <select
        aria-label="Filter by tag or prefix"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">All tags</option>
        <optgroup label="Any tag in a prefix">
          {tags.state.groups.map((group) => (
            <option
              key={group.id}
              value={`group:${group.id}`}
            >
              {group.prefix}:*
            </option>
          ))}
        </optgroup>
        <optgroup label="Specific tag">
          {tags.state.tags.map((tag) => (
            <option
              key={tag.id}
              value={`tag:${tag.id}`}
            >
              {tagLabel(tag, tags.state.groups)}
            </option>
          ))}
        </optgroup>
      </select>
      {value && (
        <button
          aria-label="Clear tag filter"
          className="icon-button"
          onClick={() => onChange('')}
          type="button"
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
};
