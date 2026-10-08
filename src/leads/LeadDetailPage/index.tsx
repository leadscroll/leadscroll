import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Notice } from '@/components/Notice';
import { PageHeader } from '@/components/PageHeader';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Form } from '@/components/ui/Form';
import { inputClass } from '@/components/ui/form';
import { fieldTitle } from '@/domain/customFields';
import { leadDisplayName } from '@/domain/leadDisplay';
import { type LeadActivity, type LeadView } from '@/domain/schemas';
import {
  emptyLeadFormValues,
  type LeadFormValues,
  leadFormValuesFromView,
  toUpdateLeadRequest,
} from '@/leads/leadFormValues';
import { request } from '@/lib/http';
import { cn } from '@/lib/styles';
import { LeadTags } from '@/tags/LeadTags';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Clock3, MessageSquare, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Link, useLocation } from 'wouter';

const formatCustomValue = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value);

export const LeadDetailPage = ({ id }: { readonly id: string }) => {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const lead = useQuery({
    queryFn: () => request<LeadView>(`/v1/leads/${id}`),
    queryKey: ['lead', id],
  });
  const activities = useQuery({
    queryFn: () => request<LeadActivity[]>(`/v1/leads/${id}/activities`),
    queryKey: ['lead-activities', id],
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const noteForm = useForm<{ body: string }>({
    defaultValues: { body: '' },
    mode: 'onTouched',
  });
  const [saveFeedback, setSaveFeedback] = useState('All changes saved');

  const record = lead.data;
  const displayName = record
    ? (leadDisplayName(record) ?? 'Unnamed lead')
    : 'Lead';
  const form = useForm<LeadFormValues>({
    defaultValues: record
      ? leadFormValuesFromView(record)
      : emptyLeadFormValues,
    mode: 'onTouched',
  });

  // A background refetch must not clobber unsaved edits: reseed the form only
  // while it is clean (on mount and after a successful save), matching the
  // previous draft-or-record behavior.
  useEffect(() => {
    if (record && !form.formState.isDirty) {
      form.reset(leadFormValuesFromView(record));
    }
  }, [form, record]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['lead', id] });
    void queryClient.invalidateQueries({ queryKey: ['leads'] });
  };

  const save = useMutation({
    mutationFn: (values: LeadFormValues) =>
      request(`/v1/leads/${id}`, {
        body: JSON.stringify(toUpdateLeadRequest(values)),
        method: 'PATCH',
      }),
    onSuccess: (_response, values) => {
      // Mark the draft clean with what was just saved; the refetch that follows
      // then reseeds the form from the server.
      form.reset(values);
      setSaveFeedback('All changes saved');
      toast.success('Lead saved');
      invalidate();
    },
  });
  const addNote = useMutation({
    mutationFn: (body: string) =>
      request(`/v1/leads/${id}/activities`, {
        body: JSON.stringify({ body }),
        method: 'POST',
      }),
    onSuccess: () => {
      noteForm.reset();
      toast.success('Note added');
      void queryClient.invalidateQueries({
        queryKey: ['lead-activities', id],
      });
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      request('/v1/leads/bulk-delete', {
        body: JSON.stringify({ ids: [id] }),
        method: 'POST',
      }),
    onSuccess: () => {
      toast.success('Lead deleted');
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      setLocation('/leads');
    },
  });

  if (lead.isPending) {
    return <p className="empty-state text-muted">Loading lead…</p>;
  }

  if (lead.error || !record) {
    return (
      <div className="p-8">
        <Notice error={lead.error ?? new Error('Lead not found.')} />
      </div>
    );
  }

  return (
    <>
      <PageHeader
        action={
          <Button
            onClick={() => setConfirmDelete(true)}
            tone="ghost"
          >
            <Trash2 size={14} /> Delete lead
          </Button>
        }
        eyebrow={
          <Link
            className="breadcrumb-link"
            href="/leads"
          >
            <ArrowLeft size={13} /> Leads
          </Link>
        }
        title={displayName}
      />
      <div className="record-content">
        <div className="record-heading">
          <Avatar
            large
            name={displayName}
          />
          <div>
            <h2>{displayName}</h2>
            <p className="record-email">{record.email ?? 'No email added'}</p>
          </div>
          <div className="record-created">
            <Clock3 size={14} />
            <span>
              Added{' '}
              {new Date(record.createdAt).toLocaleDateString(undefined, {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            </span>
          </div>
        </div>
        <LeadTags
          assigned={record.tags}
          id={id}
          key={id}
        />
        <div className="record-layout">
          <section className="record-properties">
            <div className="section-heading">
              <h3>Contact information</h3>
              <span>Contact details</span>
            </div>
            <Form
              className="lead-form"
              onSubmit={form.handleSubmit((values) => {
                if (!form.formState.isDirty) {
                  setSaveFeedback('No changes to save.');
                  return;
                }

                save.mutate(values);
              })}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="First name">
                  <input
                    className={inputClass}
                    {...form.register('firstName')}
                  />
                </Field>
                <Field label="Last name">
                  <input
                    className={inputClass}
                    {...form.register('lastName')}
                  />
                </Field>
              </div>
              <Field label="Email">
                <input
                  className={inputClass}
                  type="email"
                  {...form.register('email')}
                />
              </Field>
              <Field label="Estimated value">
                <input
                  className={inputClass}
                  min="0"
                  type="number"
                  {...form.register('estimatedValue')}
                />
              </Field>
              {save.error && <Notice error={save.error} />}
              <div className="save-row">
                <span
                  className="text-muted"
                  role="status"
                >
                  {form.formState.isDirty ? 'Unsaved changes' : saveFeedback}
                </span>
                <Button
                  disabled={save.isPending}
                  type="submit"
                >
                  {save.isPending ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            </Form>
            {record.skippedFields && record.skippedFields.length > 0 && (
              <p className="mt-5 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
                Received with {record.skippedFields.length} field
                {record.skippedFields.length === 1 ? '' : 's'} skipped by the
                browser SDK:{' '}
                {record.skippedFields
                  .map(
                    (field) =>
                      `${field.name} (${field.reason === 'sensitive' ? 'sensitive' : 'not marked'})`,
                  )
                  .join(', ')}
                . Their values were never sent.
              </p>
            )}
            <dl className="record-metadata">
              {record.tokenId !== null && (
                <div className="metadata-row">
                  <dt className="text-muted">Intake</dt>
                  <dd className="metadata-value">
                    {record.tokenType === 'browser'
                      ? 'Browser form'
                      : record.tokenType === 'api'
                        ? 'API integration'
                        : 'Intake token'}
                    {record.tokenName ? ` — ${record.tokenName}` : ''}
                  </dd>
                </div>
              )}
              {record.origin !== null && (
                <div className="metadata-row">
                  <dt className="text-muted">Origin</dt>
                  <dd className="metadata-value">{record.origin}</dd>
                </div>
              )}
              {Object.entries(record.customFields).map(([key, value]) => (
                <div
                  className="metadata-row"
                  key={key}
                >
                  <dt className="text-muted">{fieldTitle(key)}</dt>
                  <dd className="metadata-value">{formatCustomValue(value)}</dd>
                </div>
              ))}
            </dl>
            {record.rawPayload ? (
              <details className="payload-details">
                <summary className="text-muted">Received payload</summary>
                <pre className="mt-2 overflow-x-auto text-xs text-slate-300">
                  {JSON.stringify(record.rawPayload, null, 2)}
                </pre>
              </details>
            ) : null}
          </section>
          <section className="record-activity">
            <div className="section-heading">
              <h3>
                <MessageSquare size={15} /> Activity
              </h3>
              <span>Notes & updates</span>
            </div>
            <Form
              className="note-composer"
              onSubmit={noteForm.handleSubmit(({ body }) => {
                if (body.trim()) {
                  addNote.mutate(body);
                }
              })}
            >
              <Field
                error={noteForm.formState.errors.body?.message}
                label="Note"
              >
                <textarea
                  className={cn(inputClass, 'min-h-20')}
                  placeholder="Write a note about this lead…"
                  rows={3}
                  {...noteForm.register('body', {
                    validate: (value) =>
                      Boolean(value.trim()) || 'Enter a note.',
                  })}
                />
              </Field>
              {addNote.error && <Notice error={addNote.error} />}
              <div className="note-actions">
                <Button
                  disabled={addNote.isPending}
                  type="submit"
                >
                  {addNote.isPending ? 'Adding…' : 'Add note'}
                </Button>
              </div>
            </Form>
            {activities.error && <Notice error={activities.error} />}
            {activities.isPending && (
              <p
                className="text-muted"
                role="status"
              >
                Loading activity…
              </p>
            )}
            <ul className="activity-timeline">
              {(activities.data ?? []).map((activity) => (
                <li
                  className="activity-item"
                  key={activity.id}
                >
                  <span
                    aria-hidden="true"
                    className="timeline-marker"
                  >
                    <MessageSquare size={12} />
                  </span>
                  <p className="activity-body">{activity.body}</p>
                  <p className="activity-meta">
                    {activity.actorEmail ?? 'System'} ·{' '}
                    {new Date(activity.createdAt).toLocaleString()}
                  </p>
                </li>
              ))}
              {activities.data?.length === 0 && (
                <li className="activity-empty">
                  No notes yet. Start the conversation here.
                </li>
              )}
            </ul>
          </section>
        </div>
      </div>
      <ConfirmDialog
        description={`Delete "${displayName}"? This removes the lead from your workspace.`}
        onConfirm={() => remove.mutate()}
        onOpenChange={setConfirmDelete}
        open={confirmDelete}
        pending={remove.isPending}
        title="Delete lead"
      />
    </>
  );
};
