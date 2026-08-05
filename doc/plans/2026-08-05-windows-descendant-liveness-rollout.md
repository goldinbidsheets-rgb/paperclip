# Windows descendant liveness rollout

Issue: GOLAA-12653
Incident source: GOLAA-12599, run `89514526-0024-46c6-bf6d-bb8243baf78e`

## Outcome and invariants

Paperclip must not declare a tracked Windows local-agent run `process_lost` solely because its recorded `.cmd` or pipeline wrapper exited during a server restart. It must retain the existing run identity and issue execution lock only when Windows supplies positive process-tree evidence for a surviving agent descendant.

The correction preserves these invariants:

- API writes are not liveness evidence.
- The existing run and issue lock remain authoritative; the probe never creates a second execution.
- Missing or failed census data fails closed into the existing `process_lost` recovery.
- Wrapper-only descendants do not count as useful execution.
- PID reuse is bounded by the persisted wrapper start time and a 60-second child-spawn window.
- The census does not collect command lines, environment variables, or credentials.

## Implementation

At startup and during periodic orphan reconciliation, Windows local-child runs whose recorded PID is dead and which have no process-group fallback are inspected in one bounded census. The probe samples `Win32_Process` up to three times, 250 ms apart, and records only PID, parent PID, creation time, and executable name.

A run is retained as `running/process_detached` only when a live non-wrapper process has a `ParentProcessId` chain to the recorded wrapper PID and was created between five seconds before and 60 seconds after the persisted wrapper start. The evidence is written to `resultJson.windowsProcessTree` and one lifecycle event. Empty, failed, late, or wrapper-only observations proceed through the unchanged bounded `process_lost` retry path.

## Verification record

- Direct runtime assertion: live descendant accepted; empty tree rejected — PASS.
- Live Windows CIM command: completed successfully and returned a fail-closed empty result for a nonexistent root — PASS.
- Regression source added for wrapper-dead/descendant-alive continuity, including unchanged issue lock and no duplicate retry.
- Regression source added for a genuinely dead tree, including `failed/process_lost` and exactly one retry.
- Unit coverage added for parsing, wrapper-only rejection, PID-reuse window rejection, and bounded retry sampling.
- Full Vitest execution was attempted from the root and server package. The shared Windows harness could not start a worker (`vitest-pool` timeout); this is recorded as an environment limitation, not a test pass.
- Full server TypeScript execution was attempted but the compiler exceeded the bounded verification window without diagnostics. The new module was executed successfully through the repository's TypeScript runtime transform.

The reviewer must rerun the two focused suites in a healthy checkout before approving deployment:

```powershell
pnpm exec vitest run server/src/services/windows-process-tree.test.ts
pnpm exec vitest run server/src/__tests__/heartbeat-process-recovery.test.ts -t "tracked Windows wrapper|Windows wrapper tree genuinely dead"
```

## Safe deployment plan

1. Obtain Critic review of the exact commit and this rollout packet. Resolve all safety-boundary comments before merge.
2. Run the focused suites above and `pnpm --filter @paperclipai/server typecheck` in a healthy CI or developer checkout.
3. Merge and build through the normal Paperclip release path. There is no schema migration.
4. During a maintenance window, capture the current active-run census and deploy the reviewed build. Do not use an incident run as a destructive canary.
5. On a disposable non-business issue, start a Windows `.cmd`-wrapped local adapter, stop only the wrapper, restart the server normally, and verify:
   - the original run remains `running/process_detached`;
   - `resultJson.windowsProcessTree` contains bounded descendant evidence;
   - the issue retains the same `checkoutRunId` and `executionRunId`;
   - no retry run is created.
6. Run a negative canary with a dead wrapper and no descendant. Verify `failed/process_lost`, one bounded retry, and normal issue recovery.
7. Observe startup and orphan-reaper logs for one full recovery interval before declaring rollout complete.

## Rollback

Revert the reviewed commit and redeploy the prior server build. No database rollback is required. After rollback, re-read active runs and issue locks; do not manually clear locks unless the existing recovery path has positively established a dead process tree.
