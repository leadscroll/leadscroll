/**
 * Generated Worker entry for source-built installations.
 *
 * The wrapper preserves the source Worker's `fetch` handler, including the
 * execution-context argument it uses to schedule best-effort notification
 * work, and stamps the exact pinned commit. There is no `scheduled` handler:
 * notifications are event-driven and best-effort, not Cron-delivered.
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
  }
};`;
