Perform a bounded semantic audit of the deterministic repository-memory candidates below.

Delegate source verification to at least one read-only `explorer` subagent before making recommendations. Give each subagent the complete candidate claims, deterministic reasons, metadata, evidence paths, and repository context it needs. For a larger candidate set, partition candidates into bounded, non-overlapping groups and run independent subagents where useful. Subagents must not edit files, Git state, services, or memories.

After collecting the reports, independently reconcile them against current repository source and reviewed contracts. Repository authority outranks memory and subagent conclusions. Distinguish verified facts from stale, unsupported, contradictory, overly broad, privacy-sensitive, or unresolved claims.

For every candidate, recommend exactly one of:

- `keep`
- `reverify`
- `update`
- `supersede`
- `archive`
- `delete`
- `needs_user`

Include concise evidence and rationale for each recommendation. If no candidates were supplied, report that there are no deterministic findings to verify and do not launch unnecessary subagents.

This audit is advisory. Discuss recommendations with the user and do not call memory mutation actions unless the user explicitly approves them.

Checked {{checked}} records{{boundedNotice}}.

Repository:

```json
{{repository}}
```

Candidates:

```json
{{findings}}
```
