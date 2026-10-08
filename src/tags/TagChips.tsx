import { type Tag } from './types';

export const TagChip = ({
  compact = false,
  tag,
}: {
  readonly compact?: boolean;
  readonly tag: Tag;
}) => (
  <span
    className="tag-chip"
    data-color={tag.color}
    title={tag.label}
  >
    <span className="tag-label">{compact ? tag.name : tag.label}</span>
  </span>
);

export const TagChips = ({
  limit = 2,
  tags,
}: {
  readonly limit?: number;
  readonly tags: readonly Tag[];
}) => (
  <span className="tag-chips">
    {tags.slice(0, limit).map((tag) => (
      <TagChip
        key={tag.id}
        tag={tag}
      />
    ))}
    {tags.length > limit && (
      <span
        className="tag-overflow"
        title={tags
          .slice(limit)
          .map((tag) => tag.label)
          .join(', ')}
      >
        +{tags.length - limit}
      </span>
    )}
  </span>
);

export const LeadTagCell = ({ tags }: { readonly tags: readonly Tag[] }) => (
  <td className="lead-tags-cell">
    {tags.length ? (
      <TagChips
        limit={3}
        tags={tags}
      />
    ) : (
      <span className="text-muted">—</span>
    )}
  </td>
);
