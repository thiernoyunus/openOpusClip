# PostHog Self-driving Setup Report

**Project:** OpenOpusClips (id: 528420)  
**Run date:** 2026-07-25  

## Summary

PostHog Self-driving was configured for OpenOpusClips, an Electron desktop app that turns YouTube videos and local uploads into short-form clips. Error tracking, session replay, and support sources were enabled; a scout troop of three was armed (general + surveys + health-checks). Findings will start appearing in the Self-driving inbox within ~30 minutes at https://us.posthog.com/project/528420/inbox.

---

## AI data processing

**Status:** Approved. Organization-level AI data processing consent was granted before this run started.

---

## GitHub

**Status:** ⚠️ Unverified — action required.

The PostHog GitHub App install was attempted but the integration did not appear in `integrations-list` after multiple verification rounds. Self-driving can run without GitHub, but it will not be able to cross-reference findings with source code or open fix PRs until the connection is confirmed.

**Follow-up:** Verify at https://us.posthog.com/project/528420/settings/environment-integrations — scroll to the GitHub section and confirm the integration appears. If it does not, click Connect and re-install the GitHub App.

---

## Products enabled

> Note: The `products-enable` MCP tool was not available in this deployment. The product toggles below reflect the client-side SDK state found in `dashboard/src/analytics.js` and `electron/telemetry.js`. The server-side product flips should be confirmed manually.

| Product | Status | Notes |
|---|---|---|
| Session Replay | **Enabled (client-side confirmed)** | `session_recording` config present in `posthog.init`; no `disable_session_recording` override. Masking is very aggressive (`maskTextSelector: 'body'`) — recordings capture structure but no text. |
| Error Tracking | **Enabled (client-side confirmed)** | `capture_exceptions: { capture_unhandled_errors: true, capture_unhandled_rejections: true }` in `posthog.init`. Manual `captureException` calls also present via `captureError()`. |
| Support (Conversations) | **Signal source enabled; product state unknown** | The `conversations/ticket` source row was created. Tickets only arrive once an inbound channel (email / inbox / Slack) is connected in PostHog. See Follow-ups. |

**`posthog.init` override check:** Clean. No `disable_session_recording: true` or `capture_exceptions: false` found.

**Action needed:** Go to Project settings and confirm Session Replay and Error Tracking are toggled ON at the server level if they haven't been enabled there yet.

---

## Signal sources

| source_product | source_type | Action | Notes |
|---|---|---|---|
| `signals_scout` | `cross_source_issue` | **Already on (default)** | Scout gate is ON by default — no config row needed. |
| `health_checks` | `health_issue` | **Enabled** | id: `019f9b6a-c1af-7313-b59e-28eb8e33acd2` |
| `error_tracking` | `issue_created` | **Enabled** | id: `019f9b6a-c718-7c4c-a5b0-1c6070d4747c` |
| `error_tracking` | `issue_reopened` | **Enabled** | id: `019f9b6a-ca46-7b3b-87b8-b84b3e4b29f2` |
| `error_tracking` | `issue_spiking` | **Enabled** | id: `019f9b6a-d797-704c-8b81-8f0fa232876e` |
| `session_replay` | `session_analysis_cluster` | **Enabled** | id: `019f9b6a-dd1d-732d-bcc0-3b877209d2d7`; server injected `sample_rate: 0.1` |
| `conversations` | `ticket` | **Enabled** | id: `019f9b6a-e0bb-7664-b0b1-3f4e4710595c`; dormant until an inbound channel is connected |
| `llm_analytics` | — | **Skipped** | Internal-only; not a user-facing responder |
| `logs` | — | **Skipped** | Not a v1 responder; PostHog logs product not in use |

---

## Connected tools

| Tool | Status |
|---|---|
| All external tools | **Not used** — user selected none in the connected-tools prompt. |

No external issue trackers, error trackers, support desks, security scanners, or product-feedback tools were connected.

---

## Scout troop

**Run budget:** 24 runs/day (early-access default); 0 runs used today.  
**Banner:** *"Scouts are in early access so daily runs are limited to 24 by default for now, please reach out to team-self-driving@posthog.com if you would like more runs."*

### Enabled (3)

| Scout | Reason |
|---|---|
| `signals-scout-general` | Always on — watches cross-product correlations and surfaces no specialist covers. Was already enabled at sync. |
| `signals-scout-surveys` | Active PostHog survey confirmed ("OpenOpusClips in-app feedback" widget survey, created 2026-07-25). Watches for response-volume drops, abandonment spikes, and open-text themes. |
| `signals-scout-health-checks` | Cross-product; ideal for a fresh setup with no `top_events` profile yet. Watches PostHog instrumentation health and surfaces setup issues. |

### Disabled (25)

| Scout | Reason |
|---|---|
| `signals-scout-error-tracking` | **Intentional** — covered by the native `error_tracking` source (issue_created / issue_reopened / issue_spiking). Enabling this on top would duplicate. |
| `signals-scout-session-replay` | **Intentional** — covered by the native `session_replay/session_analysis_cluster` source. Enabling this on top would duplicate. |
| `signals-scout-product-analytics` | Not among the 2–3 most-used product surfaces for this project right now; re-enable in PostHog when funnels and retention insights are built. |
| `signals-scout-feature-flags` | No active feature flag usage found beyond internal survey targeting flags; re-enable if flags become a primary surface. |
| `signals-scout-anomaly-detection` | Watches dashboards and insights — limited coverage with no dashboards built yet. Re-enable once insights exist. |
| `signals-scout-web-analytics` | Desktop Electron app; no `$pageview` capture. Not applicable. |
| `signals-scout-revenue-analytics` | No payment SDK found (Stripe, Paddle, etc.). Not applicable. |
| `signals-scout-ai-observability` | No `$ai_*` events or LLM observability instrumentation found. Re-enable if PostHog AI analytics is added for the Gemini integration. |
| `signals-scout-logs` | PostHog logs product not in use. Re-enable if logs are added. |
| `signals-scout-csp-violations` | No `$csp_violation` events or CSP reporting configuration found. |
| `signals-scout-experiments` | No active A/B experiments. Re-enable if experiments are launched. |
| `signals-scout-customer-analytics` | B2C desktop app; no group/accounts analytics. Not applicable. |
| `signals-scout-data-pipelines` | No CDP destinations or batch exports configured. Re-enable if pipeline monitoring is needed. |
| `signals-scout-replay-vision` | No Replay Vision scanners configured. |
| `signals-scout-apm` | No OpenTelemetry/APM spans. Not applicable. |
| `signals-scout-conversations` | Conversations product just enabled; no `$conversation_*` events yet. Re-enable once support tickets are flowing. |
| `signals-scout-data-warehouse` | No warehouse sources connected. |
| `signals-scout-ingestion-warnings` | No specific ingestion warnings; health-checks covers this at a broader level. Re-enable if ingestion issues appear. |
| `signals-scout-insight-alerts` | No insight alerts configured. Re-enable when alerts are set up. |
| `signals-scout-inbox-validation` | Not appropriate for a fresh setup — no shipped fixes to validate yet. Re-enable after the inbox has been used for a few cycles. |
| `signals-scout-observability-gaps` | Limited events at this stage; general scout sweeps this. Re-enable once more event coverage is in place. |
| `signals-scout-mcp-tool-calls` | No `$mcp_tool_call` telemetry. Not applicable. |
| `signals-scout-skills-store` | Not needed for external product teams. |
| `signals-scout-tasks` | No PostHog Tasks in use yet. |
| `signals-scout-web-vitals` | Desktop app; no `$web_vitals`. Not applicable. |

---

## Custom scouts

**Proposed:** 2. **Created:** 0 (user selection included "none").

### Surfaces proposed but not created

**1. Video processing pipeline failures** (`signals-scout-video-processing`)

- **What it would watch:** `process_queued` → `process_started` → `process_completed` / `process_failed` events in `App.jsx`. The ratio of `process_failed` to completed+failed rising above baseline — catching FFmpeg failures, AI analysis errors, or source-specific issues before they accumulate silently.
- **Discriminator:** `process_failed` rate (7-day rolling) rising >2× the prior 7-day baseline, or an absolute spike above 10% of jobs in a day. Break down by `source_category` (remote_video vs local_file) and `failure_category`.
- **Why no built-in covers it:** `signals-scout-product-analytics` is disabled; it watches PostHog funnel *insights*, not raw events anyway. Error tracking covers `$exception` events but not domain-level job failures (these are `track()` events, not exceptions). `signals-scout-general` is too broad to catch this reliably.
- **To create it later:** go to https://us.posthog.com/project/528420/inbox, open a task, and describe the surface, or re-run this setup skill.

**2. Desktop app startup reliability** (`signals-scout-desktop-startup`)

- **What it would watch:** `desktop_app_started` (success) vs `desktop_stack_startup_failed`, `desktop_backend_startup_failed`, `desktop_render_service_startup_failed`, `desktop_backend_exited`, `desktop_render_service_exited` (failures) in `electron/telemetry.js`. Failure rate rising after a release — especially useful for catching platform-specific regressions (Apple Silicon vs Intel) early.
- **Discriminator:** Sum of startup failure events / `desktop_app_started` rising above baseline, broken down by `stage`, `error_category`, `platform`, `arch`, and `app_version`.
- **Why no built-in covers it:** These are custom `posthog-node` events (not exceptions — `enableExceptionAutocapture: false` in telemetry.js), so error tracking won't surface them. Health-checks watches PostHog's own health, not app startup health. General scout sweeps broadly but won't reliably catch a startup regression correlated with a specific release.
- **To create it later:** same as above — open a task in the inbox.

**Surfaces considered and ruled out:**

| Surface | Filter that killed it |
|---|---|
| Survey responses / feedback themes | Covered — `signals-scout-surveys` is enabled. |
| Exception spikes | Covered — native `error_tracking` source handles this. |
| Session replay friction | Covered — native `session_replay` source handles this. |
| Social posting pipeline (Zernio) | Not watchable — no specific PostHog events for posting/scheduling confirmed in the codebase. |

**Noise escape hatch:** If any enabled scout turns out noisy, go to https://us.posthog.com/project/528420/inbox and set `emit: false` on its config to switch it to dry-run. It will still run and log but produce no inbox reports.

---

## Follow-ups

- [ ] **GitHub connection (critical):** Verify the GitHub App integration appears at https://us.posthog.com/project/528420/settings/environment-integrations. Without it, Self-driving cannot research findings in code or open fix PRs.
- [ ] **Server-side product enables:** Manually confirm Session Replay and Error Tracking are toggled ON in PostHog project settings (the `products-enable` tool was unavailable during this run).
- [ ] **Connect a Support channel:** To start receiving support tickets in the inbox, connect an inbound channel (email, inbox, or Slack) in PostHog Conversations settings. The `conversations/ticket` source row is already enabled and will activate automatically once a channel is connected.
- [ ] **Add custom scouts (optional):** Two custom scouts were designed during this run but not created (video processing failures, desktop startup reliability). Create them via a task in the PostHog inbox, or re-run the Self-driving setup skill.
- [ ] **Enable `signals-scout-product-analytics`** once funnels and retention insights are built in PostHog.
- [ ] **Enable `signals-scout-ai-observability`** if `$ai_*` PostHog events are added for the Gemini API calls (would give cost/latency/error observability on AI processing).
- [ ] **Enable `signals-scout-anomaly-detection`** once dashboards and insights are built.
- [ ] **Enable `signals-scout-feature-flags`** if feature flags become a primary rollout mechanism.
- [ ] **Enable `signals-scout-conversations`** once support tickets are flowing.

---

## What happens next

The scout coordinator picks up fresh configs within ~30 minutes; first scout runs fire on the next tick and draw from the 24-run daily budget. Findings cluster into reports in the inbox — error spikes, replay session themes, survey regressions, and health issues will surface there automatically. Immediately-actionable reports can be turned into coding tasks from the inbox. Check https://us.posthog.com/project/528420/inbox in ~30 minutes for first results.
