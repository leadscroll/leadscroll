import { type ResolveStaff } from '../guards';
import { parse, type RunRequest } from '../http';
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
import { Elysia } from 'elysia';

type TagsRoutesOptions = {
  environment: Env;
  resolveStaff: ResolveStaff;
  runRequest: RunRequest;
};

export const createTagsRoutes = (options: TagsRoutesOptions) => {
  const { environment, resolveStaff, runRequest } = options;

  return (
    new Elysia({ name: 'tags-routes' })
      .resolve(({ request }) => resolveStaff(request))
      // Tag catalog. Scopes are inferred from `prefix:value` names; the API is
      // the exclusivity boundary and the database constraint is the backstop.
      .get('/v1/tags', async ({ request }) => {
        const result = await runRequest(request, listTagsCommand(environment));
        return 'error' in result ? result.error : { data: result.data };
      })
      .post('/v1/tags', async ({ body, request }) => {
        const parsed = await parse(CreateTagRequestSchema, body);
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
      })
      .patch('/v1/tag-scopes/:id', async ({ body, params, request }) => {
        const parsed = await parse(UpdateTagScopeRequestSchema, body);
        if ('error' in parsed) {
          return parsed.error;
        }

        const result = await runRequest(
          request,
          updateTagScopeCommand(environment, params.id, parsed.data),
        );
        return 'error' in result ? result.error : { data: result.data.scope };
      })
      .patch('/v1/tags/:id', async ({ body, params, request }) => {
        const parsed = await parse(UpdateTagRequestSchema, body);
        if ('error' in parsed) {
          return parsed.error;
        }

        const result = await runRequest(
          request,
          updateTagCommand(environment, params.id, parsed.data),
        );
        return 'error' in result ? result.error : { data: result.data.tag };
      })
      .delete('/v1/tags/:id', async ({ params, request }) => {
        const result = await runRequest(
          request,
          deleteTagCommand(environment, params.id),
        );
        return 'error' in result
          ? result.error
          : { data: { removed: result.data.removed } };
      })
      .put('/v1/leads/:id/tags', async ({ body, params, request }) => {
        const parsed = await parse(SetLeadTagsRequestSchema, body);
        if ('error' in parsed) {
          return parsed.error;
        }

        const result = await runRequest(
          request,
          setLeadTagsCommand(environment, params.id, parsed.data.tagIds),
        );
        return 'error' in result ? result.error : { data: result.data.tags };
      })
      .post('/v1/leads/tags/bulk', async ({ body, request }) => {
        const parsed = await parse(BulkTagRequestSchema, body);
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
      })
  );
};
