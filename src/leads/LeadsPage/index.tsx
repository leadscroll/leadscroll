import { CreateLeadDialog } from './CreateLeadDialog';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Notice } from '@/components/Notice';
import { PageHeader } from '@/components/PageHeader';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Form } from '@/components/ui/Form';
import { leadDisplayName } from '@/domain/leadDisplay';
import { type LeadView } from '@/domain/schemas';
import { request, requestBody } from '@/lib/http';
import { BulkTags } from '@/tags/LeadTags';
import { LeadTagCell } from '@/tags/TagChips';
import { TagFilter } from '@/tags/TagFilter';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import {
  ArrowUpRight,
  Inbox,
  LayoutList,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Link } from 'wouter';

type LeadPage = { data: LeadView[]; nextCursor: null | string };

export const LeadsPage = () => {
  const queryClient = useQueryClient();
  const [tagFilter, setTagFilter] = useState('');
  const [search, setSearch] = useState('');
  const hasFilters = Boolean(search || tagFilter);
  const searchForm = useForm<{ query: string }>({
    defaultValues: { query: '' },
    mode: 'onTouched',
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const leads = useInfiniteQuery({
    getNextPageParam: (lastPage: LeadPage) => lastPage.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const parameters = new URLSearchParams();
      if (search) {
        parameters.set('query', search);
      }

      // Tag filters run on the server before the keyset page is cut, so the
      // list never filters only the rows already loaded in the browser.
      if (tagFilter.startsWith('tag:')) {
        parameters.set('tag', tagFilter.slice(4));
      } else if (tagFilter.startsWith('group:')) {
        parameters.set('tagScope', tagFilter.slice(6));
      }

      if (pageParam) {
        parameters.set('cursor', pageParam);
      }

      return requestBody<LeadPage>(`/v1/leads?${parameters.toString()}`);
    },
    queryKey: ['leads', search, tagFilter],
  });
  const rows = leads.data?.pages.flatMap((page) => page.data) ?? [];

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['leads'] });
  };

  const deleteSelected = useMutation({
    mutationFn: async () => {
      // Select-all can load more than the API's 100-id bulk limit, so send
      // the selection in chunks instead of failing validation.
      for (let index = 0; index < selected.length; index += 100) {
        await request('/v1/leads/bulk-delete', {
          body: JSON.stringify({ ids: selected.slice(index, index + 100) }),
          method: 'POST',
        });
      }
    },
    onSuccess: () => {
      toast.success(
        `${String(selected.length)} ${selected.length === 1 ? 'lead' : 'leads'} deleted`,
      );
      setSelected([]);
      setConfirmDelete(false);
      invalidate();
    },
  });

  const error = leads.error ?? deleteSelected.error;

  return (
    <>
      <PageHeader
        action={
          <Button onClick={() => setShowCreate(true)}>
            <Plus size={15} /> Add lead
          </Button>
        }
        eyebrow="Workspace"
        title="Leads"
      />
      <div className="view-toolbar">
        <div className="view-label">
          <LayoutList size={15} />
          <span>All leads</span>
          {!leads.isPending && (
            <span className="count-badge">
              {rows.length}
              {leads.hasNextPage ? '+' : ''}
            </span>
          )}
        </div>
        <div className="list-controls">
          <TagFilter
            onChange={(value) => {
              setTagFilter(value);
              setSelected([]);
            }}
            value={tagFilter}
          />
          <Form
            className="search-control"
            onSubmit={searchForm.handleSubmit(({ query }) => {
              setSearch(query.trim());
              setSelected([]);
            })}
            role="search"
          >
            <button
              aria-label="Search leads"
              className="search-submit"
              type="submit"
            >
              <Search size={15} />
            </button>
            <input
              aria-label="Search leads by name or email"
              placeholder="Search leads…"
              type="search"
              {...searchForm.register('query')}
            />
            {search && (
              <button
                aria-label="Clear search"
                className="search-submit"
                onClick={() => {
                  searchForm.reset({ query: '' });
                  setSearch('');
                  setSelected([]);
                }}
                type="button"
              >
                <X size={14} />
              </button>
            )}
          </Form>
        </div>
      </div>
      {error ? (
        <div className="page-notice">
          <Notice error={error} />
        </div>
      ) : null}
      {selected.length > 0 && (
        <div className="selection-toolbar">
          <span>{selected.length} selected</span>
          <BulkTags
            ids={selected}
            onApplied={() => setSelected([])}
          />
          <Button
            onClick={() => setConfirmDelete(true)}
            tone="danger"
          >
            <Trash2 size={14} /> Delete
          </Button>
          <Button
            onClick={() => setSelected([])}
            tone="ghost"
          >
            Clear selection
          </Button>
        </div>
      )}
      {leads.isPending ? (
        <div
          aria-live="polite"
          className="empty-state"
        >
          <span className="loading-dot" />
          <p>Loading leads…</p>
        </div>
      ) : (
        <>
          <div className="table-scroll">
            <table className="leads-table">
              <caption className="sr-only">Leads in your workspace</caption>
              <thead>
                <tr>
                  <th
                    className="checkbox-cell"
                    scope="col"
                  >
                    <input
                      aria-label="Select all loaded leads"
                      checked={
                        rows.length > 0 && selected.length === rows.length
                      }
                      onChange={() =>
                        setSelected(
                          selected.length === rows.length
                            ? []
                            : rows.map((lead) => lead.id),
                        )
                      }
                      type="checkbox"
                    />
                  </th>
                  <th scope="col">Name</th>
                  <th scope="col">Tags</th>
                  <th
                    className="numeric-cell"
                    scope="col"
                  >
                    Estimated value
                  </th>
                  <th scope="col">Created</th>
                  <th
                    className="row-arrow"
                    scope="col"
                  >
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((lead) => (
                  <tr
                    data-selected={selected.includes(lead.id) || undefined}
                    key={lead.id}
                  >
                    <td className="checkbox-cell">
                      <input
                        aria-label={`Select ${leadDisplayName(lead) ?? 'unnamed lead'}`}
                        checked={selected.includes(lead.id)}
                        onChange={() =>
                          setSelected((current) =>
                            current.includes(lead.id)
                              ? current.filter((id) => id !== lead.id)
                              : [...current, lead.id],
                          )
                        }
                        type="checkbox"
                      />
                    </td>
                    <td>
                      <div className="lead-identity">
                        <Avatar name={leadDisplayName(lead) ?? '?'} />
                        <div className="lead-name-block">
                          <Link
                            className="lead-name"
                            href={`/leads/${lead.id}`}
                          >
                            {leadDisplayName(lead) ?? 'Unnamed lead'}
                          </Link>
                          {lead.email && (
                            <span className="lead-email">{lead.email}</span>
                          )}
                        </div>
                        {lead.duplicateCount > 0 && (
                          <span
                            className="duplicate-badge"
                            title="Other leads share this email"
                          >
                            {lead.duplicateCount} duplicate
                            {lead.duplicateCount === 1 ? '' : 's'}
                          </span>
                        )}
                      </div>
                    </td>
                    <LeadTagCell tags={lead.tags} />
                    <td className="numeric-cell">
                      {lead.estimatedValue === null ? (
                        <span className="text-muted">—</span>
                      ) : (
                        `$${lead.estimatedValue.toLocaleString()}`
                      )}
                    </td>
                    <td className="date-cell">
                      {new Date(lead.createdAt).toLocaleDateString(undefined, {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </td>
                    <td className="row-arrow">
                      <Link
                        aria-label={`Open ${leadDisplayName(lead) ?? 'lead'}`}
                        className="icon-button"
                        href={`/leads/${lead.id}`}
                      >
                        <ArrowUpRight size={15} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length === 0 && !leads.error && (
            <div className="empty-state">
              <span className="empty-icon">
                <Inbox size={24} />
              </span>
              <h2>
                {hasFilters
                  ? 'No matching leads'
                  : 'A place for every new opportunity'}
              </h2>
              <p>
                {hasFilters
                  ? 'Try another name, email address or tag.'
                  : 'Add your first lead, or connect a form to start collecting inquiries.'}
              </p>
              <Button
                onClick={() => {
                  if (hasFilters) {
                    searchForm.reset({ query: '' });
                    setSearch('');
                    setTagFilter('');
                  } else {
                    setShowCreate(true);
                  }
                }}
                tone="secondary"
              >
                {hasFilters ? 'Clear filters' : 'Add your first lead'}
              </Button>
            </div>
          )}
          {rows.length > 0 && (
            <div className="list-footer">
              <span>
                {rows.length} lead{rows.length === 1 ? '' : 's'}
                {search ? ` matching “${search}”` : ''}
                {leads.hasNextPage ? ' loaded' : ''}
              </span>
              {leads.hasNextPage && (
                <Button
                  disabled={leads.isFetchingNextPage}
                  onClick={() => leads.fetchNextPage()}
                  tone="secondary"
                >
                  {leads.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              )}
            </div>
          )}
        </>
      )}
      {showCreate && <CreateLeadDialog onOpenChange={setShowCreate} />}
      <ConfirmDialog
        description={`Delete ${selected.length} ${selected.length === 1 ? 'lead' : 'leads'}? This removes them from your workspace.`}
        onConfirm={() => deleteSelected.mutate()}
        onOpenChange={setConfirmDelete}
        open={confirmDelete}
        pending={deleteSelected.isPending}
        title={`Delete ${selected.length === 1 ? 'lead' : 'leads'}`}
      />
    </>
  );
};
