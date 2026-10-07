# Slack and Jira summary sharing

## Existing behavior

The Rust `ConnectorService` already stores Slack incoming-webhook and Jira Cloud
credentials privately. Slack can post notes through manual exports or existing
opt-in auto-push. Jira's old export creates one ticket per action item. The newer
post-meeting action domain reserves confirmed operations atomically, checks source
and destination revisions, and persists receipts/uncertain attempts separately
from regenerated summaries. The renderer uses feature hooks and the local API.

## Proposed change and scope

- Derive two reviewable summary suggestions for finished meetings with nonempty
  summaries: a Slack post and one Jira recap issue. Include meeting date and only
  summary text; exclude raw transcript, private notes and email drafts.
- Reuse the action review API/ledger and Jira adapter. Add a Slack adapter that
  accepts only Slack's plain-text `ok` success; sanitize failures and never retry
  automatically. An optional Slack channel label is descriptive, not a selector.
- Add a summary-page entry point and preview/edit/confirm cards with destination,
  permission, loading, error and receipt states. No extra model call/dependency.
- Keep existing opt-in Slack automation and legacy manual exports compatible;
  make their relationship to manual summary sharing clear.

Files: `actions.rs`, `action_providers.rs`, `connectors.rs`, narrow action dispatch
in `main.rs`; `MeetingActions.jsx`, `MeetingDetail.jsx`, `ConnectorsPanel.jsx`;
existing action integration test and Electron fixture/harness; this plan and
`AGENTS.md`. Canonical schema is unchanged: additive suggestions/destination and
existing `metadata.postMeetingActions` v1 receipts.

## Risks and acceptance criteria

- Viewing a summary or review never posts. Explicit confirmation is required;
  edited text resets confirmation. Jira creates exactly one recap, not task bulk.
- Source and provider changes reject stale reviews. Slack URL stays backend-only;
  changing it invalidates the safe target revision without returning the URL.
- Empty/live meetings have no summary suggestions. Oversized content requires
  explicit shortening within existing field limits, not silent truncation.
- One successful/uncertain manual delivery per meeting/provider is retained even
  after summary regeneration. Success repeats return the receipt; unknown or
  interrupted attempts block resending. There is no update/reconciliation API.
- Test both payloads, Slack text acknowledgements, permission/rate-limit/server
  failures, confirmation, stale summary/target, duplicates and persisted history.
  Existing recording, transcription, tasks and calendar behavior must pass.
- Validate backend/UI tests, real local HTTP flow, UI build, Electron interaction,
  Rust checks/build and diff whitespace. Use synthetic data/mock providers only;
  real credentials and remote writes are outside validation.

## Provider contracts

Slack incoming webhooks bind to the configured channel and normally respond with
plain text `ok`: [Slack documentation](https://api.slack.com/messaging/webhooks).
Jira Cloud issue descriptions use ADF, supported by the existing builder:
[Jira REST v3](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/).

## Implementation and validation

### UX refinement plan

Current friction: Summary switches tabs, summary sharing repeats two large action
cards, each has a redundant one-option destination select, permission recovery
opens general settings, and failed attempts remount forms and lose edits.

Keep the backend/action ledger unchanged. Extract the existing action-loading and
confirmation behavior into a shared hook. Use a compact Slack/Jira section in
Actions and a focused Radix review dialog directly from Summary. Show destination
status, an editable recap and one explicit confirmation; retain drafts in component
memory across closing/settings/rejections, keyed to source revision. Open the
Connectors settings tab directly. Switching destination or refreshing changed
sources/destinations clears confirmation. Reuse shared colors, font, buttons and
dialog primitives; no dependency/storage changes.

Acceptance: preview/switch/cancel performs no POST; Summary stays selected; edits
survive reopening and permission errors; stale confirmation resets; success and
unknown attempts are read-only; double-submit is blocked; offline/loading/empty/
error states remain reachable; keyboard focus/Escape, narrow layout and both
themes work. Validate UI tests/build, full Electron harness and whitespace. Files:
shared hook, `SummarySharing.jsx`, `MeetingActions.jsx`, `MeetingDetail.jsx`,
the shared dialog's optional portal container, `design.css`, Electron fixture/
harness, this plan and `AGENTS.md`.

Refinement implemented: one review dialog, Slack/Jira toggle instead of a redundant
select, connection details and direct Connectors setup, preserved draft edits,
immediate saved receipts, and compact sharing choices in Actions. Radix keeps
keyboard focus/Escape behavior; the optional portal container inherits Kesami's
theme tokens without changing other dialogs. Pending deliveries block dismissal/
duplicate submissions. The layout supports narrow windows and reduced motion.
No backend, data-format, dependency or recording/transcription changes.

Refinement validation: 45 UI tests, 20 focused action checks plus the isolated
real-Rust HTTP flow, UI build, Node syntax and diff whitespace passed. The full
Electron harness passed, including no POST on open/switch/cancel/setup, direct
Summary review, reconnect/permission recovery retaining drafts, destination changes
clearing confirmation, saved receipts, keyboard focus/Escape, narrow layout and AA
text contrast in both themes. Reviewed rendered screenshots and scoped diffs
against the pre-refinement files. No live Slack/Jira sends were exercised; drafts
are not persisted after leaving the meeting view/restarting.

Implemented the scope above without dependencies/schema migrations. Summary
suggestions keep stable per-provider IDs, include the meeting date in UTC, and
require reviewed content within 20 KB; no silent truncation. Slack uses plain-text
blocks, disables automatic mentions/unfurls, and accepts only a 200/`ok` receipt.
Webhook URLs are validated and never returned to the renderer; the destination
revision includes the webhook privately. Refresh preserves form edits but changing
the destination revision clears confirmation. Existing opt-in Slack auto-sharing
is disclosed during manual review. Interrupted/unknown sends block redispatch.

Checks: 318 backend tests passed (3 existing ignored); 20 focused action checks
and the real-Rust synthetic HTTP integration passed; 45 UI tests passed; UI build,
Electron full interaction harness (both themes), Rust all-target check, production
Clippy, release build, Node syntax and whitespace checks passed. Clippy retains
existing 4 library/15 binary warnings. Root/UI have no lint/typecheck script; the
whole dirty tree is not rustfmt-clean, so formatting was confined to changed code.

No live provider writes were performed. Slack setup requires an incoming webhook;
the optional channel label is user-entered display text, not verified channel
identity. Jira needs site/email/API token/project/issue type, with create permission.
Projects requiring additional custom fields may reject creation. Webhooks do not
return a message URL. Successful/uncertain manual deliveries cannot be resent or
updated through this flow; check provider state for uncertain results. Legacy
manual exports and opted-in Slack auto-sharing can still produce separate posts.
