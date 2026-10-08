import {
  type CatalogTag,
  type Tag,
  type TagCatalog,
  type TagScope,
} from './types';
import { request } from '@/lib/http';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export const TAG_CATALOG_QUERY_KEY = ['tag-catalog'] as const;

export const useTagCatalog = () =>
  useQuery({
    queryFn: () => request<TagCatalog>('/v1/tags'),
    queryKey: TAG_CATALOG_QUERY_KEY,
  });

/**
 * Writes own every invalidation they need. A catalog change can alter the
 * labels/colors shown on lead rows, so lead queries are invalidated alongside
 * the catalog; assignment writes invalidate the affected lead and the list.
 */
export const useTagMutations = () => {
  const queryClient = useQueryClient();
  const invalidateCatalog = () => {
    void queryClient.invalidateQueries({ queryKey: TAG_CATALOG_QUERY_KEY });
  };

  const invalidateLeads = () => {
    void queryClient.invalidateQueries({ queryKey: ['leads'] });
    void queryClient.invalidateQueries({ queryKey: ['lead'] });
  };

  const createTag = useMutation({
    mutationFn: (name: string) =>
      request<CatalogTag>('/v1/tags', {
        body: JSON.stringify({ name }),
        method: 'POST',
      }),
    onSuccess: invalidateCatalog,
  });
  const renameTag = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      request<CatalogTag>(`/v1/tags/${id}`, {
        body: JSON.stringify({ name }),
        method: 'PATCH',
      }),
    onSuccess: () => {
      invalidateCatalog();
      invalidateLeads();
    },
  });
  const setTagColor = useMutation({
    mutationFn: ({ color, id }: { color: string; id: string }) =>
      request<Tag>(`/v1/tags/${id}`, {
        body: JSON.stringify({ color }),
        method: 'PATCH',
      }),
    onSuccess: () => {
      invalidateCatalog();
      invalidateLeads();
    },
  });
  const deleteTag = useMutation({
    mutationFn: (id: string) =>
      request<{ removed: number }>(`/v1/tags/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidateCatalog();
      invalidateLeads();
    },
  });
  const renameScope = useMutation({
    mutationFn: ({ id, prefix }: { id: string; prefix: string }) =>
      request<TagScope>(`/v1/tag-scopes/${id}`, {
        body: JSON.stringify({ prefix }),
        method: 'PATCH',
      }),
    onSuccess: () => {
      invalidateCatalog();
      invalidateLeads();
    },
  });
  const setScopeColor = useMutation({
    mutationFn: ({ color, id }: { color: string; id: string }) =>
      request<TagScope>(`/v1/tag-scopes/${id}`, {
        body: JSON.stringify({ color }),
        method: 'PATCH',
      }),
    onSuccess: () => {
      invalidateCatalog();
      invalidateLeads();
    },
  });
  const saveLeadTags = useMutation({
    mutationFn: ({ id, tagIds }: { id: string; tagIds: string[] }) =>
      request<Tag[]>(`/v1/leads/${id}/tags`, {
        body: JSON.stringify({ tagIds }),
        method: 'PUT',
      }),
    onSuccess: (_tags, variables) => {
      invalidateCatalog();
      void queryClient.invalidateQueries({ queryKey: ['lead', variables.id] });
      invalidateLeads();
    },
  });
  const bulkTags = useMutation({
    mutationFn: ({
      ids,
      mode,
      tagIds,
    }: {
      ids: string[];
      mode: 'add' | 'remove';
      tagIds: string[];
    }) =>
      request<{ affected: number }>('/v1/leads/tags/bulk', {
        body: JSON.stringify({ ids, mode, tagIds }),
        method: 'POST',
      }),
    onSuccess: () => {
      invalidateCatalog();
      invalidateLeads();
    },
  });

  return {
    bulkTags: bulkTags.mutateAsync,
    createTag: createTag.mutateAsync,
    deleteTag: deleteTag.mutateAsync,
    renameScope: renameScope.mutateAsync,
    renameTag: renameTag.mutateAsync,
    saveLeadTags: saveLeadTags.mutateAsync,
    setScopeColor: setScopeColor.mutateAsync,
    setTagColor: setTagColor.mutateAsync,
  };
};
