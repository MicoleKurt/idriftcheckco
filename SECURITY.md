# Security policy

## Reporting

Please report vulnerabilities privately through GitHub's
["Report a vulnerability"](../../security/advisories/new) form on this repository.
You will get an acknowledgement within a few days. Please do not open a public issue.

## What counts

- A way for crafted input (a session file, trace, config, report) to execute code,
  write outside `.idriftcheckco/` or the replay worktree, or inject HTML into a report.
- A secret pattern that is stored or logged unredacted.
- Anything that makes the tool contact a host other than the user's configured model
  provider.

## Threat model in brief

- Session files and trace files are **untrusted input**. They are validated, never
  executed, and every string rendered into HTML is escaped.
- The replay agent runs with an allow-listed environment inside a throwaway git
  worktree. It is *not* a sandbox: the agent still has the permissions of your user
  account. Use `permissionMode` and run in a container for untrusted tasks.
- Redaction is pattern-based and best-effort. Review reports before publishing them.
