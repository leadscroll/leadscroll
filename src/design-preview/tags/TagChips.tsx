import { type Tag, tagLabel, type TagState } from './model';
import { useTags } from './TagProvider';

export const TagChip = ({
  compact = false,
  state,
  tag,
}: {
  readonly compact?: boolean;
  readonly state: TagState;
  readonly tag: Tag;
}) => (
  <span
    className="tag-chip"
    data-color={
      state.groups.find((group) => group.id === tag.groupId)?.color ?? tag.color
    }
    title={tagLabel(tag, state.groups)}
  >
    <span className="tag-label">
      {compact ? tag.name : tagLabel(tag, state.groups)}
    </span>
  </span>
);

export const TagChips = ({
  ids,
  limit = 2,
}: {
  readonly ids: string[];
  readonly limit?: number;
}) => {
  const tags = useTags();
  if (!tags) {
    return null;
  }

  const assigned = tags.state.tags.filter((tag) => ids.includes(tag.id));
  return (
    <span className="tag-chips">
      {assigned.slice(0, limit).map((tag) => (
        <TagChip
          key={tag.id}
          state={tags.state}
          tag={tag}
        />
      ))}
      {assigned.length > limit && (
        <span
          className="tag-overflow"
          title={assigned
            .slice(limit)
            .map((tag) => tagLabel(tag, tags.state.groups))
            .join(', ')}
        >
          +{assigned.length - limit}
        </span>
      )}
    </span>
  );
};

export const LeadTagCell = ({ id }: { readonly id: string }) => {
  const tags = useTags();
  if (!tags) {
    return null;
  }

  const ids = tags.state.assignments[id] ?? [];
  return (
    <td className="lead-tags-cell">
      {ids.length ? (
        <TagChips
          ids={ids}
          limit={3}
        />
      ) : (
        <span className="text-muted">—</span>
      )}
    </td>
  );
};
