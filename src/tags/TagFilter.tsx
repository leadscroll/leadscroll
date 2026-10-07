import { useTagCatalog } from './api';
import { X } from 'lucide-react';

/**
 * Exact-tag / any-tag-in-scope filter. The control emits an encoded selection
 * (`tag:<id>` or `group:<scopeId>`) that the leads page turns into server-side
 * query parameters, so filtering always happens before pagination.
 */
export const TagFilter = ({
  onChange,
  value,
}: {
  readonly onChange: (value: string) => void;
  readonly value: string;
}) => {
  const catalog = useTagCatalog();
  if (catalog.isPending) {
    return null;
  }

  const scopes = catalog.data?.scopes ?? [];
  const tags = catalog.data?.tags ?? [];
  return (
    <div className="tag-filter">
      <select
        aria-label="Filter by tag or prefix"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">All tags</option>
        <optgroup label="Any tag in a prefix">
          {scopes.map((scope) => (
            <option
              key={scope.id}
              value={`group:${scope.id}`}
            >
              {scope.prefix}:*
            </option>
          ))}
        </optgroup>
        <optgroup label="Specific tag">
          {tags.map((tag) => (
            <option
              key={tag.id}
              value={`tag:${tag.id}`}
            >
              {tag.label}
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
