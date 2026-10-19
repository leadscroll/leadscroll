import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';

const idParameters = { id: Schema.String };
const tokenParameters = { token: Schema.String };

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
  HttpApiEndpoint.get('listLeads', '/v1/leads', { disableCodecs: true }),
  HttpApiEndpoint.post('createLead', '/v1/leads', { disableCodecs: true }),
  HttpApiEndpoint.post('bulkDeleteLeads', '/v1/leads/bulk-delete', {
    disableCodecs: true,
  }),
  HttpApiEndpoint.get('getLead', '/v1/leads/:id', {
    disableCodecs: true,
    params: idParameters,
  }),
  HttpApiEndpoint.patch('updateLead', '/v1/leads/:id', {
    disableCodecs: true,
    params: idParameters,
  }),
  HttpApiEndpoint.get('listLeadActivities', '/v1/leads/:id/activities', {
    disableCodecs: true,
    params: idParameters,
  }),
  HttpApiEndpoint.post('createLeadActivity', '/v1/leads/:id/activities', {
    disableCodecs: true,
    params: idParameters,
  }),
  HttpApiEndpoint.put('setLeadTags', '/v1/leads/:id/tags', {
    disableCodecs: true,
    params: idParameters,
  }),
  HttpApiEndpoint.post('bulkTag', '/v1/leads/tags/bulk', {
    disableCodecs: true,
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
  HttpApiGroup.make('leads').add(...leadEndpoints),
  HttpApiGroup.make('tags').add(...tagEndpoints),
  HttpApiGroup.make('access').add(...accessEndpoints),
  HttpApiGroup.make('account').add(...accountEndpoints),
  HttpApiGroup.make('email').add(...emailEndpoints),
);
