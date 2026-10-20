import { runBoundary } from '../handler-utilities';
import { toTagCatalog, toTagScopeView, toTagView } from '../views';
import {
  createTagCommand,
  deleteTagCommand,
  listTagsCommand,
  updateTagCommand,
  updateTagScopeCommand,
} from '@/application/tag-commands';
import { type Env } from '@/db/repository';
import {
  type CreateTagRequest,
  type UpdateTagRequest,
  type UpdateTagScopeRequest,
} from '@/domain/schemas';
import { Effect } from 'effect';
import { type HttpServerRequest } from 'effect/http';

type HandlerOptions = {
  environment: Env;
};

type ParametersArguments = RequestArguments & { params: { id: string } };

type PayloadArguments<A> = RequestArguments & { payload: A };

type RequestArguments = {
  request: HttpServerRequest.HttpServerRequest;
};

export const createTagsHandlers = (options: HandlerOptions) => {
  const { environment } = options;

  return {
    createTag: ({ payload, request }: PayloadArguments<CreateTagRequest>) =>
      Effect.gen(function* () {
        const result = yield* runBoundary(
          request,
          createTagCommand(environment, payload.name),
        );
        return { data: toTagView(result.tag) };
      }),

    deleteTag: ({ params, request }: ParametersArguments) =>
      Effect.gen(function* () {
        const result = yield* runBoundary(
          request,
          deleteTagCommand(environment, params.id),
        );
        return { data: { removed: result.removed } };
      }),

    listTags: ({ request }: RequestArguments) =>
      Effect.gen(function* () {
        const catalog = yield* runBoundary(
          request,
          listTagsCommand(environment),
        );
        return { data: toTagCatalog(catalog) };
      }),

    updateTag: ({
      params,
      payload,
      request,
    }: ParametersArguments & PayloadArguments<UpdateTagRequest>) =>
      Effect.gen(function* () {
        const result = yield* runBoundary(
          request,
          updateTagCommand(environment, params.id, payload),
        );
        return { data: toTagView(result.tag) };
      }),

    updateTagScope: ({
      params,
      payload,
      request,
    }: ParametersArguments & PayloadArguments<UpdateTagScopeRequest>) =>
      Effect.gen(function* () {
        const result = yield* runBoundary(
          request,
          updateTagScopeCommand(environment, params.id, payload),
        );
        return { data: toTagScopeView(result.scope) };
      }),
  };
};
