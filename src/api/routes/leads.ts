import { mapApiError } from '../error-logging';
import { ApiNotFoundError, ApiValidationError } from '../errors';
import {
  CurrentStaff,
  type NotificationDispatcherShape,
  publisherFor,
} from '../services';
import { toLeadActivity, toLeadView, toTagView } from '../views';
import {
  createLeadActivityCommand,
  createLeadCommand,
  softDeleteLeadsCommand,
  updateLeadCommand,
} from '@/application/commands';
import { persist } from '@/application/errors';
import { bulkTagCommand, setLeadTagsCommand } from '@/application/tag-commands';
import {
  type Env,
  getLead,
  listLeadActivities,
  listLeads,
} from '@/db/repository';
import { decodeKeysetCursor, LIST_LIMIT_DEFAULT } from '@/domain/pagination';
import {
  type CreateLeadActivityRequest,
  type CreateLeadRequest,
  type ListLeadsQuery,
  type UpdateLeadRequest,
} from '@/domain/schemas';
import { requestTelemetry } from '@/telemetry/request';
import { Effect } from 'effect';
import { HttpServerRequest } from 'effect/http';

type HandlerOptions = {
  dispatcher: NotificationDispatcherShape;
  environment: Env;
};

type ParametersArguments = {
  params: { id: string };
  request: HttpServerRequest.HttpServerRequest;
};

type PayloadArguments<A> = RequestArguments & { payload: A };

type QueryArguments<A> = RequestArguments & { query: A };
type RequestArguments = {
  request: HttpServerRequest.HttpServerRequest;
};

const webRequest = (request: HttpServerRequest.HttpServerRequest) =>
  HttpServerRequest.toWeb(request).pipe(Effect.orDie);

const traced = <A, E, R>(
  request: Request,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const telemetry = requestTelemetry(request);
  return telemetry === null
    ? effect
    : (telemetry.provide(effect) as Effect.Effect<A, E, R>);
};

/**
 * Effect handlers for the schema-first leads group. Dependencies are
 * composition services; the authenticated staff context is provided by the
 * StaffAuth middleware.
 */
export const createLeadsHandlers = (options: HandlerOptions) => {
  const { dispatcher, environment } = options;

  return {
    bulkDeleteLeads: ({
      payload,
      request,
    }: PayloadArguments<{ ids: readonly string[] }>) =>
      Effect.gen(function* () {
        const web = yield* webRequest(request);
        const result = yield* traced(
          web,
          mapApiError(web, softDeleteLeadsCommand(environment, payload.ids)),
        );
        return { data: { deleted: result } };
      }),

    bulkTag: ({
      payload,
      request,
    }: PayloadArguments<{
      ids: readonly string[];
      mode: 'add' | 'remove';
      tagIds: readonly string[];
    }>) =>
      Effect.gen(function* () {
        const web = yield* webRequest(request);
        const result = yield* traced(
          web,
          mapApiError(
            web,
            bulkTagCommand(
              environment,
              payload.ids,
              payload.tagIds,
              payload.mode,
            ),
          ),
        );
        return { data: { affected: result.affected } };
      }),

    createLead: ({ payload, request }: PayloadArguments<CreateLeadRequest>) =>
      Effect.gen(function* () {
        const staff = yield* CurrentStaff;
        const web = yield* webRequest(request);
        const lead = yield* traced(
          web,
          mapApiError(
            web,
            createLeadCommand(
              environment,
              payload,
              staff.adminUserId,
              publisherFor(dispatcher, web),
            ),
          ),
        );
        return { data: toLeadView(lead) };
      }),

    createLeadActivity: ({
      params,
      payload,
      request,
    }: ParametersArguments & { payload: CreateLeadActivityRequest }) =>
      Effect.gen(function* () {
        const staff = yield* CurrentStaff;
        const web = yield* webRequest(request);
        const activity = yield* traced(
          web,
          mapApiError(
            web,
            createLeadActivityCommand(
              environment,
              params.id,
              staff.adminEmail,
              payload.kind ?? 'note',
              payload.body,
            ),
          ),
        );
        return activity === null
          ? yield* Effect.fail(
              new ApiNotFoundError({
                code: 'not_found',
                message: 'Lead not found.',
              }),
            )
          : { data: toLeadActivity(activity) };
      }),

    getLead: ({ params, request }: ParametersArguments) =>
      Effect.gen(function* () {
        const web = yield* webRequest(request);
        const lead = yield* traced(
          web,
          mapApiError(
            web,
            persist(() => getLead(environment, params.id)),
          ),
        );
        return lead === null
          ? yield* Effect.fail(
              new ApiNotFoundError({
                code: 'not_found',
                message: 'Lead not found.',
              }),
            )
          : { data: toLeadView(lead) };
      }),

    listLeadActivities: ({ params, request }: ParametersArguments) =>
      Effect.gen(function* () {
        const web = yield* webRequest(request);
        const activities = yield* traced(
          web,
          mapApiError(
            web,
            persist(() => listLeadActivities(environment, params.id)),
          ),
        );
        return { data: activities.map(toLeadActivity) };
      }),

    listLeads: ({ query, request }: QueryArguments<ListLeadsQuery>) =>
      Effect.gen(function* () {
        const web = yield* webRequest(request);
        let cursor = null;
        if (query.cursor !== undefined) {
          cursor = decodeKeysetCursor(query.cursor);
          if (cursor === null) {
            return yield* Effect.fail(
              new ApiValidationError({
                code: 'invalid_cursor',
                message:
                  'cursor is invalid. Use the nextCursor value from a previous response.',
              }),
            );
          }
        }

        const page = yield* traced(
          web,
          mapApiError(
            web,
            persist(() =>
              listLeads(environment, {
                cursor,
                limit: query.limit ?? LIST_LIMIT_DEFAULT,
                query: query.query,
                tagId: query.tag,
                tagScopeId: query.tagScope,
              }),
            ),
          ),
        );
        return {
          data: page.leads.map(toLeadView),
          nextCursor: page.nextCursor,
        };
      }),

    setLeadTags: ({
      params,
      payload,
      request,
    }: ParametersArguments & PayloadArguments<{ tagIds: readonly string[] }>) =>
      Effect.gen(function* () {
        const web = yield* webRequest(request);
        const result = yield* traced(
          web,
          mapApiError(
            web,
            setLeadTagsCommand(environment, params.id, payload.tagIds),
          ),
        );
        return { data: result.tags.map(toTagView) };
      }),

    updateLead: ({
      params,
      payload,
      request,
    }: ParametersArguments & { payload: UpdateLeadRequest }) =>
      Effect.gen(function* () {
        const web = yield* webRequest(request);
        const lead = yield* traced(
          web,
          mapApiError(web, updateLeadCommand(environment, params.id, payload)),
        );
        return lead === null
          ? yield* Effect.fail(
              new ApiNotFoundError({
                code: 'not_found',
                message: 'Lead not found.',
              }),
            )
          : { data: toLeadView(lead) };
      }),
  };
};
