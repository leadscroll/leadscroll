import { type ResolveStaff } from '../guards';
import { errorResponse, type EventsFor, type RunRequest } from '../http';
import {
  createLeadActivityCommand,
  createLeadCommand,
  softDeleteLeadsCommand,
  updateLeadCommand,
} from '@/application/commands';
import {
  type Env,
  getLead,
  listLeadActivities,
  listLeads,
} from '@/db/repository';
import { decodeKeysetCursor, LIST_LIMIT_DEFAULT } from '@/domain/pagination';
import {
  BulkDeleteLeadsRequestSchema,
  CreateLeadActivityRequestSchema,
  CreateLeadRequestSchema,
  ListLeadsQuerySchema,
  UpdateLeadRequestSchema,
} from '@/domain/schemas';
import { Schema } from 'effect';
import { Elysia } from 'elysia';

type LeadsRoutesOptions = {
  environment: Env;
  eventsFor: EventsFor;
  resolveStaff: ResolveStaff;
  runRequest: RunRequest;
};

export const createLeadsRoutes = (options: LeadsRoutesOptions) => {
  const { environment, eventsFor, resolveStaff, runRequest } = options;

  return new Elysia({ name: 'leads-routes' })
    .resolve(({ request }) => resolveStaff(request))
    .get(
      '/v1/leads',
      async ({ query }) => {
        let cursor = null;
        if (query.cursor !== undefined) {
          cursor = decodeKeysetCursor(query.cursor);
          if (cursor === null) {
            return errorResponse(
              422,
              'invalid_cursor',
              'cursor is invalid. Use the nextCursor value from a previous response.',
            );
          }
        }

        const page = await listLeads(environment, {
          cursor,
          limit: query.limit ?? LIST_LIMIT_DEFAULT,
          query: query.query,
          tagId: query.tag,
          tagScopeId: query.tagScope,
        });
        return { data: page.leads, nextCursor: page.nextCursor };
      },
      { query: Schema.toStandardSchemaV1(ListLeadsQuerySchema) },
    )
    .post(
      '/v1/leads',
      async ({ adminUserId, body, request }) => {
        const result = await runRequest(
          request,
          createLeadCommand(environment, body, adminUserId, eventsFor(request)),
        );
        return 'error' in result
          ? result.error
          : Response.json({ data: result.data }, { status: 201 });
      },
      { body: Schema.toStandardSchemaV1(CreateLeadRequestSchema) },
    )
    .post(
      '/v1/leads/bulk-delete',
      async ({ body, request }) => {
        const result = await runRequest(
          request,
          softDeleteLeadsCommand(environment, body.ids),
        );
        return 'error' in result
          ? result.error
          : { data: { deleted: result.data } };
      },
      { body: Schema.toStandardSchemaV1(BulkDeleteLeadsRequestSchema) },
    )
    .patch(
      '/v1/leads/:id',
      async ({ body, params, request }) => {
        const result = await runRequest(
          request,
          updateLeadCommand(environment, params.id, body),
        );
        if ('error' in result) {
          return result.error;
        }

        return result.data
          ? { data: result.data }
          : errorResponse(404, 'not_found', 'Lead not found.');
      },
      { body: Schema.toStandardSchemaV1(UpdateLeadRequestSchema) },
    )
    .get('/v1/leads/:id/activities', async ({ params }) => {
      return { data: await listLeadActivities(environment, params.id) };
    })
    .post(
      '/v1/leads/:id/activities',
      async ({ adminEmail, body, params, request }) => {
        const result = await runRequest(
          request,
          createLeadActivityCommand(
            environment,
            params.id,
            adminEmail,
            body.kind ?? 'note',
            body.body,
          ),
        );
        if ('error' in result) {
          return result.error;
        }

        return result.data
          ? Response.json({ data: result.data }, { status: 201 })
          : errorResponse(404, 'not_found', 'Lead not found.');
      },
      { body: Schema.toStandardSchemaV1(CreateLeadActivityRequestSchema) },
    )
    .get('/v1/leads/:id', async ({ params }) => {
      const lead = await getLead(environment, params.id);
      return lead
        ? { data: lead }
        : errorResponse(404, 'not_found', 'Lead not found.');
    });
};
