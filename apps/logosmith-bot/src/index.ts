// PLACEHOLDER — do not extend. This file is fully specified by
// `.superpowers/sdd/2026-07-30-logosmith/task-10-brief.md`'s successor,
// "Task 12: Worker entry — bindings, service graph, webhook handlers, routes"
// (docs/superpowers/plans/2026-07-30-logosmith.md), which will replace this
// wholesale. Per that plan's "Testability rule", `index.ts` is deliberately
// the ONLY module that touches real Cloudflare bindings, and is intentionally
// the LAST file the Phase A/B/C tasks create — every other module (including
// config.ts) is Node-testable without it.
//
// It exists here, many tasks early, ONLY because `wrangler.jsonc`'s `"main":
// "src/index.ts"` (Task 1, written verbatim per task-1-brief.md Step 3) needs
// an entry point for `wrangler deploy --dry-run` to bundle, and Task 1's own
// acceptance bar (task-1-brief.md Step 10) requires the dry run to succeed.
// See task-1-report.md, "Concerns", for the full explanation of this
// plan-sequencing gap.
//
// No service graph, no routes, no bindings wiring — that is Task 12's job.
export default {
  fetch(): Response {
    return new Response('LogoSmith: not yet implemented (see Task 12)', { status: 501 });
  },
};
