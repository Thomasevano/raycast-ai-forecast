# Agent instructions

## Agent skills

- Issues and specs live in GitHub Issues. Before tracker operations, read [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).
- Before assigning triage roles, read [docs/agents/triage-labels.md](docs/agents/triage-labels.md).
- Before resolving terminology or recording decisions, read [docs/agents/domain.md](docs/agents/domain.md).

## Development completion

After implementation and verification, automatically run `/tvn-code-review` before reporting completion or opening/updating a PR. Follow [docs/agents/code-review.md](docs/agents/code-review.md) and the priorities in [REVIEW.md](REVIEW.md).

## Safety

Use isolated synthetic quota/history data for checks. Real account history, monitoring settings, GUI launches and test notifications require explicit authorization. Keep credentials and personal filesystem paths out of source, documentation and evidence.
