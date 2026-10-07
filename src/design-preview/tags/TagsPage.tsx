import { removeCatalogTag } from './catalog';
import { CatalogColor, CatalogMenu } from './CatalogControls';
import { type Tag, type TagGroup, tagLabel } from './model';
import { TagChip } from './TagChips';
import { ScopeNameForm, TagForm } from './TagForms';
import { useTags } from './TagProvider';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { ChevronDown, ChevronRight, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

type Editor =
  | { group: TagGroup; kind: 'scope' }
  | { initialName?: string; kind: 'tag'; tag?: Tag };

export const TagsPage = () => {
  const tags = useTags();
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [deleting, setDeleting] = useState<null | Tag>(null);
  if (!tags) {
    return null;
  }

  const { state } = tags;
  const visible = state.tags.filter((tag) =>
    tagLabel(tag, state.groups).includes(search.trim().toLowerCase()),
  );
  const groups = [...state.groups].toSorted((a, b) =>
    a.prefix.localeCompare(b.prefix),
  );
  const count = (id: string) =>
    Object.values(state.assignments).filter((ids) => ids.includes(id)).length;
  const tagRow = (tag: Tag) => (
    <tr
      className={
        tag.groupId ? 'catalog-tag-row catalog-tag-child' : 'catalog-tag-row'
      }
      key={tag.id}
    >
      <td>
        <TagChip
          compact={Boolean(tag.groupId)}
          state={state}
          tag={tag}
        />
      </td>
      <td>
        {!tag.groupId && (
          <CatalogColor
            color={tag.color}
            label={tag.name}
            onChange={(color) => {
              tags.setState((current) => ({
                ...current,
                tags: current.tags.map((item) =>
                  item.id === tag.id ? { ...item, color } : item,
                ),
              }));
              toast.success('Tag color updated');
            }}
          />
        )}
      </td>
      <td className="catalog-usage">{count(tag.id)}</td>
      <td>
        <CatalogMenu
          actions={[
            { label: 'Rename', onClick: () => setEditor({ kind: 'tag', tag }) },
            { danger: true, label: 'Delete', onClick: () => setDeleting(tag) },
          ]}
          label={`Actions for ${tagLabel(tag, state.groups)}`}
        />
      </td>
    </tr>
  );

  return (
    <>
      <PageHeader
        action={
          <Button onClick={() => setEditor({ kind: 'tag' })}>
            <Plus size={15} /> New tag
          </Button>
        }
        eyebrow="Manage"
        title="Tags"
      />
      <div className="tag-catalog-page">
        <div className="tag-catalog-toolbar">
          <span>
            {state.tags.length} tags · {state.groups.length} scopes
          </span>
          <div className="search-control">
            <Search
              aria-hidden="true"
              size={14}
            />
            <input
              aria-label="Search tag catalog"
              onChange={(event) => {
                setSearch(event.target.value);
                setCollapsed([]);
              }}
              placeholder="Find a tag or scope…"
              type="search"
              value={search}
            />
          </div>
        </div>
        <div className="catalog-table-wrap">
          <table className="catalog-table">
            <caption className="sr-only">Tag catalog</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th
                  className="catalog-color-column"
                  scope="col"
                >
                  Color
                </th>
                <th
                  className="catalog-usage"
                  scope="col"
                >
                  Leads
                </th>
                <th
                  className="catalog-action-column"
                  scope="col"
                >
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            {groups.map((group) => {
              const members = visible
                .filter((tag) => tag.groupId === group.id)
                .toSorted((a, b) => a.name.localeCompare(b.name));
              if (!members.length) {
                return null;
              }

              const expanded = !collapsed.includes(group.id);
              const scopeIds = state.tags
                .filter((tag) => tag.groupId === group.id)
                .map((tag) => tag.id);
              const usage = Object.values(state.assignments).filter((ids) =>
                scopeIds.some((id) => ids.includes(id)),
              ).length;
              return (
                <tbody key={group.id}>
                  <tr className="catalog-scope-row">
                    <td>
                      <button
                        aria-expanded={expanded}
                        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${group.prefix} scope`}
                        className="catalog-scope-toggle"
                        onClick={() =>
                          setCollapsed((current) =>
                            expanded
                              ? [...current, group.id]
                              : current.filter((id) => id !== group.id),
                          )
                        }
                        type="button"
                      >
                        {expanded ? (
                          <ChevronDown size={14} />
                        ) : (
                          <ChevronRight size={14} />
                        )}
                        <span>{group.prefix}</span>
                        <span className="count-badge">{scopeIds.length}</span>
                      </button>
                    </td>
                    <td>
                      <CatalogColor
                        color={group.color}
                        label={`${group.prefix} scope`}
                        onChange={(color) => {
                          tags.setState((current) => ({
                            ...current,
                            groups: current.groups.map((item) =>
                              item.id === group.id ? { ...item, color } : item,
                            ),
                          }));
                          toast.success('Scope color updated');
                        }}
                      />
                    </td>
                    <td className="catalog-usage">{usage}</td>
                    <td>
                      <CatalogMenu
                        actions={[
                          {
                            label: 'New tag',
                            onClick: () =>
                              setEditor({
                                initialName: `${group.prefix}:`,
                                kind: 'tag',
                              }),
                          },
                          {
                            label: 'Rename scope',
                            onClick: () => setEditor({ group, kind: 'scope' }),
                          },
                        ]}
                        label={`Actions for ${group.prefix} scope`}
                      />
                    </td>
                  </tr>
                  {expanded && members.map(tagRow)}
                </tbody>
              );
            })}
            <tbody>
              {visible
                .filter((tag) => !tag.groupId)
                .toSorted((a, b) => a.name.localeCompare(b.name))
                .map(tagRow)}
            </tbody>
          </table>
        </div>
        {!visible.length && (
          <p className="catalog-empty">
            {search
              ? 'No matching tags or scopes.'
              : 'No tags yet. Create your first tag above.'}
          </p>
        )}
        <p className="catalog-footer">
          Use <code>scope:value</code> for mutually exclusive tags. Colors are
          shared within a scope.
        </p>
      </div>
      {editor?.kind === 'tag' && (
        <TagForm
          initialName={editor.initialName}
          onClose={() => setEditor(null)}
          tag={editor.tag}
        />
      )}
      {editor?.kind === 'scope' && (
        <ScopeNameForm
          group={editor.group}
          onClose={() => setEditor(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          description={`Delete ${tagLabel(deleting, state.groups)}? It will be removed from ${count(deleting.id)} ${count(deleting.id) === 1 ? 'lead' : 'leads'}. Other tags and leads will remain.`}
          onConfirm={() => {
            tags.setState((current) => removeCatalogTag(current, deleting.id));
            setDeleting(null);
            toast.success('Tag deleted');
          }}
          onOpenChange={(open) => {
            if (!open) {
              setDeleting(null);
            }
          }}
          open
          title="Delete tag"
        />
      )}
    </>
  );
};
