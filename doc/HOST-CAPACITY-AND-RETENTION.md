# Host Capacity Admission and State Retention

Paperclip hosts need two separate controls:

1. a run-admission floor that protects the control plane from disk exhaustion;
2. evidence-aware retention rules for each class of local state.

The admission floor is enforced by Paperclip. Retention remains an operator
policy because the safe evidence and recovery windows are deployment-specific.
An operator must not treat all files below the instance root as one cleanup
class.

## Run-admission floor

Set `PAPERCLIP_RUN_MIN_FREE_BYTES` to a positive integer byte count in the
server environment. When it is set, Paperclip measures available bytes on the
filesystem containing the instance root immediately before claiming a queued
heartbeat run.

`PAPERCLIP_RUN_CAPACITY_PATH` can select another path on the same volume when
the configured instance path does not identify the constrained filesystem.
The path must exist and be readable by the server process. If it is not set,
Paperclip measures the configured instance root.

The behavior is fail-closed once a floor is configured:

- free bytes at or above the floor allow the ordinary claim path;
- free bytes below the floor fail the queued run before an execution lock or
  adapter process is created;
- an invalid byte value or a failed filesystem measurement also fails the run;
- an unset floor preserves the historical behavior and performs no probe.

The failed run uses error code `host_capacity_preflight_blocked`. Its result,
lifecycle event, activity record, and server log include the reason and exact
decimal `freeBytes` and `minimumFreeBytes` values when available. The queued to
failed update is a compare-and-swap, so concurrent scheduler/manual dispatches
produce one terminal receipt.

Choose and ratify the floor per host. Leave enough space for a peak run,
database recovery, log growth, and the operator's response interval. Record the
approved byte value and the filesystem it protects in the deployment change.
Do not silently invent a default during an incident.

## Retention classes

Every cleanup must identify its class, eligibility evidence, recovery path,
and audit receipt before mutation.

| State class | Eligibility gate | Safe disposition |
| --- | --- | --- |
| Run scratch | Paperclip-owned marker, expired minimum age, no live process/run reference, and no reparse-point escape | Delete idempotently with a per-pass count/byte audit. Scratch is reproducible and is not an archive. |
| Managed execution workspaces | Owning issue tree is terminal, the configured reaper cooldown elapsed, and no active run or runtime lease exists | Use the Paperclip execution-workspace archive/reaper path. Do not age-delete an agent root or arbitrary repository. |
| Durable run logs | Run is terminal, final state is durably recorded, log size and digest are inventoried, and no hold applies | Move to a recoverable archive first. Delete only after a separately ratified archive window and a fresh eligibility check. |
| Database backups | A newer complete backup is verified, the configured backup retention generations remain present, and no recovery/incident hold applies | Prune through the database-backup policy. Never process backup files as scratch or generic logs. |

Retention jobs must serialize or use atomic claim/rename operations so a
manual run racing a scheduled run cannot disposition the same object twice.
The receipt must record the policy revision, object identity, original and
final location, byte count, decision, timestamp, and error when applicable.
A failed or uncertain mutation is read back before retry.

## Mandatory holds

No retention window overrides these holds:

- an active, queued, or recovering run;
- an issue with a live checkout, execution lock, reviewer, approval,
  interaction, or monitor continuation;
- unresolved incident, audit, or recovery evidence;
- an explicit legal, board, security, or forensic hold;
- a workspace with uncommitted work unless a verified recoverable snapshot is
  already retained.

Retired-adapter and ambiguous-result artifacts are forensic evidence. Preserve
them until the governing decision explicitly releases the hold; never replay
them merely to determine whether they are disposable.

## Deployment sequence

1. Inventory the constrained filesystem and document the approved byte floor.
2. Validate the configured capacity path and run the preflight tests on the
   target operating system.
3. Stage the server change without enabling the floor.
4. Apply the ratified environment value as a full, reviewed server-environment
   change and restart through the deployment runbook.
5. Queue a harmless test run above the floor, then test the blocked path with a
   controlled threshold that cannot start an adapter.
6. Read back the run, lifecycle event, activity receipt, and server health.
7. Enable each retention class independently only after its windows and hold
   evidence have been approved.

The admission guard keeps the API/control plane available. It does not create
space, prune evidence, or authorize a retention action.
