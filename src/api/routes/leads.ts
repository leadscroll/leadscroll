import { type StaffContext } from '../guards';
import {
  errorResponse,
  type EventsFor,
  parse,
  readJsonBody,
  type RouteContext,
  type RunRequest,
} from '../http';
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

export type IdParameters = { id: string };

type LeadsHandlerOptions = {
  environment: Env;
  eventsFor: EventsFor;
  runRequest: RunRequest;
};

type StaffRoute<P = Record<string, never>> = RouteContext<P> & {
  staff: StaffContext;
};

export const createLeadsHandlers = (options: LeadsHandlerOptions) => {
  const { environment, eventsFor, runRequest } = options;

  return {
    bulkDeleteLeads: async ({ request }: StaffRoute) => {
      const body = await readJsonBody(request);
      if ('error' in body) {
        return body.error;
      }

      const parsed = await parse(BulkDeleteLeadsRequestSchema, body.data);
      if ('error' in parsed) {
        return parsed.error;
      }

      const result = await runRequest(
        request,
        softDeleteLeadsCommand(environment, parsed.data.ids),
      );
      return 'error' in result
        ? result.error
        : { data: { deleted: result.data } };
    },
    createLead: async ({ request, staff }: StaffRoute) => {
      const body = await readJsonBody(request);
      if ('error' in body) {
        return body.error;
      }

      const parsed = await parse(CreateLeadRequestSchema, body.data);
      if ('error' in parsed) {
        return parsed.error;
      }

      const result = await runRequest(
        request,
        createLeadCommand(
          environment,
          parsed.data,
          staff.adminUserId,
          eventsFor(request),
        ),
      );
      return 'error' in result
        ? result.error
        : Response.json({ data: result.data }, { status: 201 });
    },
    createLeadActivity: async ({
      params,
      request,
      staff,
    }: StaffRoute<IdParameters>) => {
      const body = await readJsonBody(request);
      if ('error' in body) {
        return body.error;
      }

      const parsed = await parse(CreateLeadActivityRequestSchema, body.data);
      if ('error' in parsed) {
        return parsed.error;
      }

      const result = await runRequest(
        request,
        createLeadActivityCommand(
          environment,
          params.id,
          staff.adminEmail,
          parsed.data.kind ?? 'note',
          parsed.data.body,
        ),
      );
      if ('error' in result) {
        return result.error;
      }

      return result.data
        ? Response.json({ data: result.data }, { status: 201 })
        : errorResponse(404, 'not_found', 'Lead not found.');
    },
    getLead: async ({ params }: StaffRoute<IdParameters>) => {
      const lead = await getLead(environment, params.id);
      return lead
        ? { data: lead }
        : errorResponse(404, 'not_found', 'Lead not found.');
    },
    listLeadActivities: async ({ params }: StaffRoute<IdParameters>) => {
      return { data: await listLeadActivities(environment, params.id) };
    },
    listLeads: async ({ request }: StaffRoute) => {
      const parsed = await parse(
        ListLeadsQuerySchema,
        Object.fromEntries(new URL(request.url).searchParams),
      );
      if ('error' in parsed) {
        return parsed.error;
      }

      const query = parsed.data;
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
    updateLead: async ({ params, request }: StaffRoute<IdParameters>) => {
      const body = await readJsonBody(request);
      if ('error' in body) {
        return body.error;
      }

      const parsed = await parse(UpdateLeadRequestSchema, body.data);
      if ('error' in parsed) {
        return parsed.error;
      }

      const result = await runRequest(
        request,
        updateLeadCommand(environment, params.id, parsed.data),
      );
      if ('error' in result) {
        return result.error;
      }

      return result.data
        ? { data: result.data }
        : errorResponse(404, 'not_found', 'Lead not found.');
    },
  };
};
