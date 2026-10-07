// Form values and request mappers for lead create/update.
//
// Every `*FormValues` module is a DOM-to-contract adapter: the forms hold
// strings (what inputs produce) while the request schemas are typed. Each
// adapter return value is annotated with the type derived from its request
// schema, so a contract rename, removal, type change, or new required field
// fails `tsc` here instead of silently dropping fields on the wire. Tests
// decode every mapper output through the schema with onExcessProperty:
// 'error' for the constraint-level checks types cannot express.
//
// The contract distinguishes "empty" per direction: create treats blank as
// absent (the key is omitted), update sends an explicit null to clear.

import {
  type CreateLeadRequest,
  type LeadView,
  type UpdateLeadRequest,
} from '@/domain/schemas';

export type LeadFormValues = {
  [K in LeadFormField]: string;
};

// The manual lead form collects every request field except customFields and
// tags; tags are owned by the chip input draft, not the RHF string form. A new
// contract field therefore becomes a required form field (and a compile error
// in `emptyLeadFormValues`) until it is collected or explicitly excluded here,
// and a removed/renamed field breaks the mappers below.
type LeadFormField = Exclude<keyof CreateLeadRequest, 'customFields' | 'tags'>;

export const emptyLeadFormValues: LeadFormValues = {
  email: '',
  estimatedValue: '',
  firstName: '',
  lastName: '',
  // The separate source control is replaced by the source:* tag; manual
  // creates omit source so the server records its manual default.
  source: '',
};

const trimmedOrUndefined = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

const nullable = (value: string): null | string => {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

export const toCreateLeadRequest = (
  values: LeadFormValues,
): CreateLeadRequest => ({
  email: trimmedOrUndefined(values.email),
  estimatedValue:
    values.estimatedValue.trim() === ''
      ? undefined
      : Number(values.estimatedValue),
  firstName: trimmedOrUndefined(values.firstName),
  lastName: trimmedOrUndefined(values.lastName),
  source: trimmedOrUndefined(values.source),
});

export const toUpdateLeadRequest = (
  values: LeadFormValues,
): UpdateLeadRequest => ({
  email: nullable(values.email),
  estimatedValue:
    values.estimatedValue.trim() === '' ? null : Number(values.estimatedValue),
  firstName: nullable(values.firstName),
  lastName: nullable(values.lastName),
  source: values.source.trim() || undefined,
});

type LeadFormSource = Pick<LeadView, LeadFormField>;

export const leadFormValuesFromView = (
  lead: LeadFormSource,
): LeadFormValues => ({
  email: lead.email ?? '',
  estimatedValue:
    lead.estimatedValue === null ? '' : String(lead.estimatedValue),
  firstName: lead.firstName ?? '',
  lastName: lead.lastName ?? '',
  source: lead.source,
});
