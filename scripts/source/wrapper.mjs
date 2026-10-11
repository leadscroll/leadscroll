/**
 * Generated Worker entry for source-built installations.
 *
 * The wrapper preserves the source Worker's `fetch` and `scheduled` handlers.
 * `fetch` also stamps the exact pinned commit; scheduled dispatch must be
 * forwarded or installed installations would silently stop processing
 * notifications even though the source Worker handles them.
 */
export const sourceWorkerWrapper = (
  commit,
) => `import core from './src/worker-global.ts';
export default {
  async fetch(request, env, ctx) {
    const response = await core.fetch(request, env, ctx);
    const stamped = new Response(response.body, response);
    stamped.headers.set('X-LeadScroll-Commit', ${JSON.stringify(commit)});
    return stamped;
  },
  async scheduled(controller, env, ctx) {
    return core.scheduled(controller, env, ctx);
  }
};`;
