import { type StaffContext } from '../guards';
import {
  parse,
  readJsonBody,
  type RouteContext,
  type RunRequest,
} from '../http';
import {
  bulkTagCommand,
  createTagCommand,
  deleteTagCommand,
  listTagsCommand,
  setLeadTagsCommand,
  updateTagCommand,
  updateTagScopeCommand,
} from '@/application/tag-commands';
import { type Env } from '@/db/repository';
import {
  BulkTagRequestSchema,
  CreateTagRequestSchema,
  SetLeadTagsRequestSchema,
  UpdateTagRequestSchema,
  UpdateTagScopeRequestSchema,
} from '@/domain/schemas';

export type IdParameters = { id: string };

type StaffRoute<P = Record<string, never>> = RouteContext<P> & {
  staff: StaffContext;
};

type TagsHandlerOptions = {
  environment: Env;
  runRequest: RunRequest;
};

export const createTagsHandlers = (options: TagsHandlerOptions) => {
  const { environment, runRequest } = options;

  return {
    bulkTag: async ({ request }: StaffRoute) => {
      const body = await readJsonBody(request);
      if ('error' in body) {
        return body.error;
      }

      const parsed = await parse(BulkTagRequestSchema, body.data);
      if ('error' in parsed) {
        return parsed.error;
      }

      const result = await runRequest(
        request,
        bulkTagCommand(
          environment,
          parsed.data.ids,
          parsed.data.tagIds,
          parsed.data.mode,
        ),
      );
      return 'error' in result
        ? result.error
        : { data: { affected: result.data.affected } };
    },
    createTag: async ({ request }: StaffRoute) => {
      const body = await readJsonBody(request);
      if ('error' in body) {
        return body.error;
      }

      const parsed = await parse(CreateTagRequestSchema, body.data);
      if ('error' in parsed) {
        return parsed.error;
      }

      const result = await runRequest(
        request,
        createTagCommand(environment, parsed.data.name),
      );
      if ('error' in result) {
        return result.error;
      }

      return Response.json({ data: result.data.tag }, { status: 201 });
    },
    deleteTag: async ({ params, request }: StaffRoute<IdParameters>) => {
      const result = await runRequest(
        request,
        deleteTagCommand(environment, params.id),
      );
      return 'error' in result
        ? result.error
        : { data: { removed: result.data.removed } };
    },
    listTags: async ({ request }: StaffRoute) => {
      const result = await runRequest(request, listTagsCommand(environment));
      return 'error' in result ? result.error : { data: result.data };
    },
    setLeadTags: async ({ params, request }: StaffRoute<IdParameters>) => {
      const body = await readJsonBody(request);
      if ('error' in body) {
        return body.error;
      }

      const parsed = await parse(SetLeadTagsRequestSchema, body.data);
      if ('error' in parsed) {
        return parsed.error;
      }

      const result = await runRequest(
        request,
        setLeadTagsCommand(environment, params.id, parsed.data.tagIds),
      );
      return 'error' in result ? result.error : { data: result.data.tags };
    },
    updateTag: async ({ params, request }: StaffRoute<IdParameters>) => {
      const body = await readJsonBody(request);
      if ('error' in body) {
        return body.error;
      }

      const parsed = await parse(UpdateTagRequestSchema, body.data);
      if ('error' in parsed) {
        return parsed.error;
      }

      const result = await runRequest(
        request,
        updateTagCommand(environment, params.id, parsed.data),
      );
      return 'error' in result ? result.error : { data: result.data.tag };
    },
    updateTagScope: async ({ params, request }: StaffRoute<IdParameters>) => {
      const body = await readJsonBody(request);
      if ('error' in body) {
        return body.error;
      }

      const parsed = await parse(UpdateTagScopeRequestSchema, body.data);
      if ('error' in parsed) {
        return parsed.error;
      }

      const result = await runRequest(
        request,
        updateTagScopeCommand(environment, params.id, parsed.data),
      );
      return 'error' in result ? result.error : { data: result.data.scope };
    },
  };
};
