import { StaffApiErrors } from './errors';
import { ApiSchemaErrors } from './schema-errors';
import { StaffAuth } from './staff-auth';
import {
  BulkDeleteLeadsRequestSchema,
  BulkTagRequestSchema,
  CreateLeadActivityRequestSchema,
  CreateLeadRequestSchema,
  LeadActivitiesSchema,
  LeadActivitySchema,
  LeadViewSchema,
  ListLeadsQuerySchema,
  SetLeadTagsRequestSchema,
  TagViewSchema,
  UpdateLeadRequestSchema,
} from '@/domain/schemas';
import { Schema } from 'effect';
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from 'effect/http-api';

const idParameters = { id: Schema.String };
const tokenParameters = { token: Schema.String };

const LeadDataResponse = Schema.Struct({ data: LeadViewSchema });
const LeadCreatedResponse = LeadDataResponse.pipe(HttpApiSchema.status(201));
const LeadsPageResponse = Schema.Struct({
  data: Schema.Array(LeadViewSchema),
  nextCursor: Schema.NullOr(Schema.String),
});
const LeadDeletedResponse = Schema.Struct({
  data: Schema.Struct({
    deleted: Schema.Number.check(Schema.isInt()),
  }),
});
const LeadActivityCreatedResponse = Schema.Struct({
  data: LeadActivitySchema,
}).pipe(HttpApiSchema.status(201));
const LeadTagsResponse = Schema.Struct({
  data: Schema.Array(TagViewSchema),
});
const BulkTagResponse = Schema.Struct({
  data: Schema.Struct({
    affected: Schema.Number.check(Schema.isInt()),
  }),
});

const healthEndpoint = HttpApiEndpoint.get('health', '/health', {
  disableCodecs: true,
});

const inviteValidationEndpoint = HttpApiEndpoint.post(
  'validateInvite',
  '/api/invites/validate',
  { disableCodecs: true },
);

const intakeEndpoints = [
  HttpApiEndpoint.post('createIntake', '/v1/intakes', { disableCodecs: true }),
  HttpApiEndpoint.post('createPublicIntake', '/v1/public/intakes/:token', {
    disableCodecs: true,
    params: tokenParameters,
  }),
  HttpApiEndpoint.options('publicIntakeOptions', '/v1/public/intakes/:token', {
    disableCodecs: true,
    params: tokenParameters,
  }),
] as const;

const leadEndpoints = [
  HttpApiEndpoint.get('listLeads', '/v1/leads', {
    error: StaffApiErrors,
    query: ListLeadsQuerySchema,
    success: LeadsPageResponse,
  }),
  HttpApiEndpoint.post('createLead', '/v1/leads', {
    error: StaffApiErrors,
    payload: CreateLeadRequestSchema,
    success: LeadCreatedResponse,
  }),
  HttpApiEndpoint.post('bulkDeleteLeads', '/v1/leads/bulk-delete', {
    error: StaffApiErrors,
    payload: BulkDeleteLeadsRequestSchema,
    success: LeadDeletedResponse,
  }),
  HttpApiEndpoint.get('getLead', '/v1/leads/:id', {
    error: StaffApiErrors,
    params: idParameters,
    success: LeadDataResponse,
  }),
  HttpApiEndpoint.patch('updateLead', '/v1/leads/:id', {
    error: StaffApiErrors,
    params: idParameters,
    payload: UpdateLeadRequestSchema,
    success: LeadDataResponse,
  }),
  HttpApiEndpoint.get('listLeadActivities', '/v1/leads/:id/activities', {
    error: StaffApiErrors,
    params: idParameters,
    success: LeadActivitiesSchema,
  }),
  HttpApiEndpoint.post('createLeadActivity', '/v1/leads/:id/activities', {
    error: StaffApiErrors,
    params: idParameters,
    payload: CreateLeadActivityRequestSchema,
    success: LeadActivityCreatedResponse,
  }),
  HttpApiEndpoint.put('setLeadTags', '/v1/leads/:id/tags', {
    error: StaffApiErrors,
    params: idParameters,
    payload: SetLeadTagsRequestSchema,
    success: LeadTagsResponse,
  }),
  HttpApiEndpoint.post('bulkTag', '/v1/leads/tags/bulk', {
    error: StaffApiErrors,
    payload: BulkTagRequestSchema,
    success: BulkTagResponse,
  }),
] as const;

const tagEndpoints = [
  HttpApiEndpoint.get('listTags', '/v1/tags', { disableCodecs: true }),
  HttpApiEndpoint.post('createTag', '/v1/tags', { disableCodecs: true }),
  HttpApiEndpoint.patch('updateTag', '/v1/tags/:id', {
    disableCodecs: true,
    params: idParameters,
  }),
  HttpApiEndpoint.delete('deleteTag', '/v1/tags/:id', {
    disableCodecs: true,
    params: idParameters,
  }),
  HttpApiEndpoint.patch('updateTagScope', '/v1/tag-scopes/:id', {
    disableCodecs: true,
    params: idParameters,
  }),
] as const;

const accessEndpoints = [
  HttpApiEndpoint.get('listTokens', '/v1/tokens', { disableCodecs: true }),
  HttpApiEndpoint.post('createToken', '/v1/tokens', { disableCodecs: true }),
  HttpApiEndpoint.delete('revokeToken', '/v1/tokens/:id', {
    disableCodecs: true,
    params: idParameters,
  }),
  HttpApiEndpoint.get('listInvites', '/v1/invites', { disableCodecs: true }),
  HttpApiEndpoint.post('createInvite', '/v1/invites', { disableCodecs: true }),
  HttpApiEndpoint.delete('revokeInvite', '/v1/invites/:id', {
    disableCodecs: true,
    params: idParameters,
  }),
  HttpApiEndpoint.get('listStaff', '/v1/staff', { disableCodecs: true }),
  HttpApiEndpoint.patch('setStaffDisabled', '/v1/staff/:id', {
    disableCodecs: true,
    params: idParameters,
  }),
] as const;

const accountEndpoints = [
  HttpApiEndpoint.get('listSessions', '/v1/account/sessions', {
    disableCodecs: true,
  }),
  HttpApiEndpoint.delete('revokeSession', '/v1/account/sessions/:id', {
    disableCodecs: true,
    params: idParameters,
  }),
  HttpApiEndpoint.post(
    'revokeOtherSessions',
    '/v1/account/sessions/revoke-others',
    { disableCodecs: true },
  ),
  HttpApiEndpoint.get(
    'getNotificationPreference',
    '/v1/account/notifications',
    { disableCodecs: true },
  ),
  HttpApiEndpoint.put(
    'updateNotificationPreference',
    '/v1/account/notifications',
    { disableCodecs: true },
  ),
] as const;

const emailEndpoints = [
  HttpApiEndpoint.get('getEmailSettings', '/v1/settings/email', {
    disableCodecs: true,
  }),
  HttpApiEndpoint.put('updateEmailSettings', '/v1/settings/email', {
    disableCodecs: true,
  }),
  HttpApiEndpoint.post('sendTestEmail', '/v1/settings/email/test', {
    disableCodecs: true,
  }),
] as const;

export const api = HttpApi.make('leadscroll').add(
  HttpApiGroup.make('health').add(healthEndpoint),
  HttpApiGroup.make('invites').add(inviteValidationEndpoint),
  HttpApiGroup.make('intake').add(...intakeEndpoints),
  HttpApiGroup.make('leads')
    .add(...leadEndpoints)
    .middleware(StaffAuth)
    .middleware(ApiSchemaErrors),
  HttpApiGroup.make('tags').add(...tagEndpoints),
  HttpApiGroup.make('access').add(...accessEndpoints),
  HttpApiGroup.make('account').add(...accountEndpoints),
  HttpApiGroup.make('email').add(...emailEndpoints),
);
