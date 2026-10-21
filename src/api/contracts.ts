import { IntakeApiErrors, StaffApiErrors } from './errors';
import { ApiSchemaErrors } from './schema-errors';
import { StaffAuth, StaffSession, StaffUser } from './staff-auth';
import {
  AccountSessionViewSchema,
  BulkDeleteLeadsRequestSchema,
  BulkTagRequestSchema,
  CreateInviteRequestSchema,
  CreateLeadActivityRequestSchema,
  CreateLeadRequestSchema,
  CreateTagRequestSchema,
  CreateTokenRequestSchema,
  EmailSettingsViewSchema,
  EmailTestViewSchema,
  HealthSchema,
  IntakeRequestSchema,
  LeadActivitiesSchema,
  LeadActivitySchema,
  LeadViewSchema,
  ListLeadsQuerySchema,
  NotificationPreferenceViewSchema,
  SendEmailTestRequestSchema,
  SetLeadTagsRequestSchema,
  SetStaffDisabledRequestSchema,
  TagCatalogSchema,
  TagScopeViewSchema,
  TagViewSchema,
  UpdateEmailSettingsRequestSchema,
  UpdateLeadRequestSchema,
  UpdateNotificationPreferenceRequestSchema,
  UpdateTagRequestSchema,
  UpdateTagScopeRequestSchema,
  ValidateInviteRequestSchema,
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
const TagCatalogResponse = Schema.Struct({ data: TagCatalogSchema });
const TagDataResponse = Schema.Struct({ data: TagViewSchema });
const TagCreatedResponse = TagDataResponse.pipe(HttpApiSchema.status(201));
const TagScopeDataResponse = Schema.Struct({ data: TagScopeViewSchema });
const TagDeletedResponse = Schema.Struct({
  data: Schema.Struct({ removed: Schema.Number.check(Schema.isInt()) }),
});
const ApiTokenViewSchema = Schema.Struct({
  createdAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
  id: Schema.String,
  lastUsedAt: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.String,
  prefix: Schema.String,
  revokedAt: Schema.NullOr(Schema.String),
  scope: Schema.String,
  token: Schema.NullOr(Schema.String),
  type: Schema.Literals(['api', 'browser']),
});
const InviteViewSchema = Schema.Struct({
  createdAt: Schema.String,
  expiresAt: Schema.String,
  id: Schema.String,
  name: Schema.String,
  prefix: Schema.String,
  revokedAt: Schema.NullOr(Schema.String),
  usedAt: Schema.NullOr(Schema.String),
});
const StaffAccountViewSchema = Schema.Struct({
  disabledAt: Schema.NullOr(Schema.String),
  email: Schema.String,
  id: Schema.String,
  name: Schema.String,
});
const InviteValidationResponse = Schema.Struct({ valid: Schema.Boolean });
const ApiTokenListResponse = Schema.Struct({
  data: Schema.Array(ApiTokenViewSchema),
});
const ApiTokenCreatedResponse = Schema.Struct({
  data: ApiTokenViewSchema,
}).pipe(HttpApiSchema.status(201));
const InviteListResponse = Schema.Struct({
  data: Schema.Array(InviteViewSchema),
});
const InviteCreatedResponse = Schema.Struct({
  data: Schema.Struct({ ...InviteViewSchema.fields, token: Schema.String }),
}).pipe(HttpApiSchema.status(201));
const StaffListResponse = Schema.Struct({
  data: Schema.Array(StaffAccountViewSchema),
});
const StaffAccountResponse = Schema.Struct({ data: StaffAccountViewSchema });
const AccountSessionListResponse = Schema.Struct({
  data: Schema.Array(AccountSessionViewSchema),
});
const RevokedSessionsResponse = Schema.Struct({
  data: Schema.Struct({ revoked: Schema.Number.check(Schema.isInt()) }),
});
const NotificationPreferenceResponse = Schema.Struct({
  data: NotificationPreferenceViewSchema,
});
const EmailSettingsResponse = Schema.Struct({
  data: EmailSettingsViewSchema,
});
const EmailTestResponse = Schema.Struct({ data: EmailTestViewSchema });

const healthEndpoint = HttpApiEndpoint.get('health', '/health', {
  success: HealthSchema,
});

const inviteValidationEndpoint = HttpApiEndpoint.post(
  'validateInvite',
  '/api/invites/validate',
  {
    error: StaffApiErrors,
    payload: ValidateInviteRequestSchema,
    success: InviteValidationResponse,
  },
);

const IntakeCreatedResponse = Schema.Struct({
  data: Schema.Struct({ created: Schema.Boolean, leadId: Schema.String }),
}).pipe(HttpApiSchema.status(201));
const PublicIntakeCreatedResponse = Schema.Struct({
  data: Schema.Struct({ created: Schema.Literal(true) }),
}).pipe(HttpApiSchema.status(201));

const intakeEndpoints = [
  HttpApiEndpoint.post('createIntake', '/v1/intakes', {
    error: IntakeApiErrors,
    payload: IntakeRequestSchema,
    success: IntakeCreatedResponse,
  }),
  HttpApiEndpoint.post('createPublicIntake', '/v1/public/intakes/:token', {
    error: IntakeApiErrors,
    params: tokenParameters,
    payload: IntakeRequestSchema,
    success: PublicIntakeCreatedResponse,
  }),
  HttpApiEndpoint.options('publicIntakeOptions', '/v1/public/intakes/:token', {
    params: tokenParameters,
    success: HttpApiSchema.NoContent,
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
  HttpApiEndpoint.get('listTags', '/v1/tags', {
    error: StaffApiErrors,
    success: TagCatalogResponse,
  }),
  HttpApiEndpoint.post('createTag', '/v1/tags', {
    error: StaffApiErrors,
    payload: CreateTagRequestSchema,
    success: TagCreatedResponse,
  }),
  HttpApiEndpoint.patch('updateTag', '/v1/tags/:id', {
    error: StaffApiErrors,
    params: idParameters,
    payload: UpdateTagRequestSchema,
    success: TagDataResponse,
  }),
  HttpApiEndpoint.delete('deleteTag', '/v1/tags/:id', {
    error: StaffApiErrors,
    params: idParameters,
    success: TagDeletedResponse,
  }),
  HttpApiEndpoint.patch('updateTagScope', '/v1/tag-scopes/:id', {
    error: StaffApiErrors,
    params: idParameters,
    payload: UpdateTagScopeRequestSchema,
    success: TagScopeDataResponse,
  }),
] as const;

const accessEndpoints = [
  HttpApiEndpoint.get('listTokens', '/v1/tokens', {
    error: StaffApiErrors,
    success: ApiTokenListResponse,
  }),
  HttpApiEndpoint.post('createToken', '/v1/tokens', {
    error: StaffApiErrors,
    payload: CreateTokenRequestSchema,
    success: ApiTokenCreatedResponse,
  }),
  HttpApiEndpoint.delete('revokeToken', '/v1/tokens/:id', {
    error: StaffApiErrors,
    params: idParameters,
    success: HttpApiSchema.NoContent,
  }),
  HttpApiEndpoint.get('listInvites', '/v1/invites', {
    error: StaffApiErrors,
    success: InviteListResponse,
  }),
  HttpApiEndpoint.post('createInvite', '/v1/invites', {
    error: StaffApiErrors,
    payload: CreateInviteRequestSchema,
    success: InviteCreatedResponse,
  }),
  HttpApiEndpoint.delete('revokeInvite', '/v1/invites/:id', {
    error: StaffApiErrors,
    params: idParameters,
    success: HttpApiSchema.NoContent,
  }),
  HttpApiEndpoint.get('listStaff', '/v1/staff', {
    error: StaffApiErrors,
    success: StaffListResponse,
  }),
  HttpApiEndpoint.patch('setStaffDisabled', '/v1/staff/:id', {
    error: StaffApiErrors,
    params: idParameters,
    payload: SetStaffDisabledRequestSchema,
    success: StaffAccountResponse,
  }),
] as const;

const accountEndpoints = [
  HttpApiEndpoint.get('listSessions', '/v1/account/sessions', {
    error: StaffApiErrors,
    success: AccountSessionListResponse,
  }).middleware(StaffSession),
  HttpApiEndpoint.delete('revokeSession', '/v1/account/sessions/:id', {
    error: StaffApiErrors,
    params: idParameters,
    success: HttpApiSchema.NoContent,
  }).middleware(StaffSession),
  HttpApiEndpoint.post(
    'revokeOtherSessions',
    '/v1/account/sessions/revoke-others',
    {
      error: StaffApiErrors,
      success: RevokedSessionsResponse,
    },
  ).middleware(StaffSession),
  HttpApiEndpoint.get(
    'getNotificationPreference',
    '/v1/account/notifications',
    {
      error: StaffApiErrors,
      success: NotificationPreferenceResponse,
    },
  ).middleware(StaffUser),
  HttpApiEndpoint.put(
    'updateNotificationPreference',
    '/v1/account/notifications',
    {
      error: StaffApiErrors,
      payload: UpdateNotificationPreferenceRequestSchema,
      success: NotificationPreferenceResponse,
    },
  ).middleware(StaffUser),
] as const;

const emailEndpoints = [
  HttpApiEndpoint.get('getEmailSettings', '/v1/settings/email', {
    error: StaffApiErrors,
    success: EmailSettingsResponse,
  }),
  HttpApiEndpoint.put('updateEmailSettings', '/v1/settings/email', {
    error: StaffApiErrors,
    payload: UpdateEmailSettingsRequestSchema,
    success: EmailSettingsResponse,
  }),
  HttpApiEndpoint.post('sendTestEmail', '/v1/settings/email/test', {
    error: StaffApiErrors,
    payload: SendEmailTestRequestSchema,
    success: EmailTestResponse,
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
  HttpApiGroup.make('tags')
    .add(...tagEndpoints)
    .middleware(StaffAuth)
    .middleware(ApiSchemaErrors),
  HttpApiGroup.make('access')
    .add(...accessEndpoints)
    .middleware(StaffAuth)
    .middleware(ApiSchemaErrors),
  HttpApiGroup.make('account')
    .add(...accountEndpoints)
    .middleware(ApiSchemaErrors),
  HttpApiGroup.make('email')
    .add(...emailEndpoints)
    .middleware(StaffUser)
    .middleware(ApiSchemaErrors),
);
