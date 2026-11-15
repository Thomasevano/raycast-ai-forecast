# Development review

1. One verification owner runs relevant checks and the changed runnable path, recording exact commands, outcomes and reviewed content identity. Use isolated data as required by root `AGENTS.md`.
2. Run `/tvn-code-review` in fresh reviewer contexts against a fixed baseline. Keep Standards and Spec reviews independent. Add Bug Hunt and Security reviews for persistence, migrations, concurrency, external-input or CI changes. Apply root `REVIEW.md`.
3. Reviewers remain read-only and do not rerun the author's checks. Independently counter-verify actionable candidates with a fresh reviewer and a trace or reproducer.
4. The author fixes confirmed defects, then re-reviews affected paths. Preserve dispositions; after three review/fix cycles, stop for a maintainer decision.
5. Use `/pr` and `.github/pull_request_template.md`. State the final reviewed scope, exercised runtime evidence, unresolved gaps and risk. Native GitHub review is separate from local skill execution; do not claim it is configured or enable cloud services implicitly.

A passing build does not prove the Raycast window, background scheduler or Notification Center presentation. Report those gaps explicitly. Reviews do not authorize automatic merge.
