import { useTagCatalog, useTagMutations } from './api';
import { CatalogColor, CatalogMenu } from './CatalogControls';
import { TagChip } from './TagChips';
import { ScopeNameForm, TagForm } from './TagForms';
import { type CatalogTag, type Tag, type TagScope } from './types';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Notice } from '@/components/Notice';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { ChevronDown, ChevronRight, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

type Editor =
  | { initialName?: string; kind: 'tag'; tag?: Tag }
  | { kind: 'scope'; scope: TagScope };

const messageOf = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : 'The request could not be completed.';

export const TagsPage = () => {
  const catalog = useTagCatalog();
  const { deleteTag, setScopeColor, setTagColor } = useTagMutations();
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [deleting, setDeleting] = useState<CatalogTag | null>(null);

  if (catalog.isPending) {
    return (
      <div
        aria-live="polite"
        className="empty-state"
      >
        <span className="loading-dot" />
        <p>Loading tags…</p>
      </div>
    );
  }

  if (catalog.error || !catalog.data) {
    return (
      <div className="page-notice">
        <Notice
          error={catalog.error ?? new Error('The tag catalog failed to load.')}
        />
      </div>
    );
  }

  const { scopes, tags } = catalog.data;
  const visible = tags.filter((tag) =>
    tag.label.includes(search.trim().toLowerCase()),
  );
  const orderedScopes = [...scopes].toSorted((a, b) =>
    a.prefix.localeCompare(b.prefix),
  );
  const tagRow = (tag: CatalogTag) => (
    <tr
      className={
        tag.scopeId ? 'catalog-tag-row catalog-tag-child' : 'catalog-tag-row'
      }
      key={tag.id}
    >
      <td>
        <TagChip
          compact={Boolean(tag.scopeId)}
          tag={tag}
        />
      </td>
      <td>
        {!tag.scopeId && (
          <CatalogColor
            color={tag.color}
            label={tag.name}
            onChange={(color) => {
              void (async () => {
                try {
                  await setTagColor({ color, id: tag.id });
                  toast.success('Tag color updated');
                } catch (error) {
                  toast.error(messageOf(error));
                }
              })();
            }}
          />
        )}
      </td>
      <td className="catalog-usage">{tag.leadCount}</td>
      <td>
        <CatalogMenu
          actions={[
            { label: 'Rename', onClick: () => setEditor({ kind: 'tag', tag }) },
            { danger: true, label: 'Delete', onClick: () => setDeleting(tag) },
          ]}
          label={`Actions for ${tag.label}`}
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
            {tags.length} tags · {scopes.length} scopes
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
            {orderedScopes.map((scope) => {
              const members = visible
                .filter((tag) => tag.scopeId === scope.id)
                .toSorted((a, b) => a.name.localeCompare(b.name));
              if (!members.length) {
                return null;
              }

              const expanded = !collapsed.includes(scope.id);
              const scopeIds = tags
                .filter((tag) => tag.scopeId === scope.id)
                .map((tag) => tag.id);
              return (
                <tbody key={scope.id}>
                  <tr className="catalog-scope-row">
                    <td>
                      <button
                        aria-expanded={expanded}
                        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${scope.prefix} scope`}
                        className="catalog-scope-toggle"
                        onClick={() =>
                          setCollapsed((current) =>
                            expanded
                              ? [...current, scope.id]
                              : current.filter((id) => id !== scope.id),
                          )
                        }
                        type="button"
                      >
                        {expanded ? (
                          <ChevronDown size={14} />
                        ) : (
                          <ChevronRight size={14} />
                        )}
                        <span>{scope.prefix}</span>
                        <span className="count-badge">{scopeIds.length}</span>
                      </button>
                    </td>
                    <td>
                      <CatalogColor
                        color={scope.color}
                        label={`${scope.prefix} scope`}
                        onChange={(color) => {
                          void (async () => {
                            try {
                              await setScopeColor({ color, id: scope.id });
                              toast.success('Scope color updated');
                            } catch (error) {
                              toast.error(messageOf(error));
                            }
                          })();
                        }}
                      />
                    </td>
                    <td className="catalog-usage">
                      {members.reduce((total, tag) => total + tag.leadCount, 0)}
                    </td>
                    <td>
                      <CatalogMenu
                        actions={[
                          {
                            label: 'New tag',
                            onClick: () =>
                              setEditor({
                                initialName: `${scope.prefix}:`,
                                kind: 'tag',
                              }),
                          },
                          {
                            label: 'Rename scope',
                            onClick: () => setEditor({ kind: 'scope', scope }),
                          },
                        ]}
                        label={`Actions for ${scope.prefix} scope`}
                      />
                    </td>
                  </tr>
                  {expanded && members.map(tagRow)}
                </tbody>
              );
            })}
            <tbody>
              {visible
                .filter((tag) => !tag.scopeId)
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
          onClose={() => setEditor(null)}
          scope={editor.scope}
        />
      )}
      {deleting && (
        <ConfirmDialog
          description={`Delete ${deleting.label}? It will be removed from ${String(deleting.leadCount)} ${deleting.leadCount === 1 ? 'lead' : 'leads'}. Other tags and leads will remain.`}
          onConfirm={() => {
            void (async () => {
              try {
                const result = await deleteTag(deleting.id);
                setDeleting(null);
                toast.success(
                  `Tag deleted${result.removed ? ` from ${String(result.removed)} ${result.removed === 1 ? 'lead' : 'leads'}` : ''}`,
                );
              } catch (error) {
                toast.error(messageOf(error));
              }
            })();
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
