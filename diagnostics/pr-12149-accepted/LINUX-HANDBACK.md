# Exact-candidate Linux execution handoff

Execution is held for native CEO source review on GOLAA-40580 and the separate external-publication/dispatch decision on GOLAA-25130. This package grants no deployment or merge authority. The main review archive is internal; only the explicit public-only archive allowlist below is proposed for external execution.

## Fixed inputs

Use source-identity.json for the exact final candidate/tree/parents. Node v24.13.1, pnpm 9.15.4. A clean Linux checkout is mandatory. Do not chase master, install a local Linux runtime, fetch credentials, or reuse Windows node_modules. The host probe returned the WSL installation/help stub and no Docker command; local Linux execution was not established.

Public-only allowlist: candidate.bundle, source-identity.json, linux-verify.py, LINUX-HANDBACK.md. No board comments, internal test receipts, run transcripts, agent configuration, or credentials are included. The bundle contains public-source Git commits only, including the previously source-accepted c88c9bd53 merge and this repair. Its two prerequisites are the accepted published 11259bdfb2d43045f39551ab9d0119b0931b422b and fixed upstream 0b80ea17ef324385161c1430e87f8bb0707d8de9; provision those Git objects before using the bundle. Do not fetch a floating branch to substitute for these objects.

In an authorized isolated public-source clone, verify the bundle, fetch its HEAD into a local review ref, and create a fresh checkout at the candidate from source-identity.json:

```sh
git bundle verify /review/candidate.bundle
git fetch /review/candidate.bundle HEAD:refs/heads/golaa-40580-review
# Substitute the exact candidate from source-identity.json, not a branch tip.
git -c core.autocrlf=false worktree add --detach /work/golaa-40580 <candidate>
python3 /review/linux-verify.py /work/golaa-40580 /results/golaa-40580
```

The script asserts commit/tree, clean source, no preexisting node_modules, and lock SHA256; uses an environment allowlist with a temporary home; and preserves every command, exit, full log, JSON test report, binary hash and final evidence manifest. It runs frozen filtered install without a local lock overlay, prerequisite package builds, locked native Rust build, the four actual warm-attach cases, directory-fsync injection, the repaired scheduling subset, and server typecheck. There is no timeout override, source overlay, skip insertion, or live provider invocation. A nonzero command stops the package while retaining evidence. Existing package-registry and Cargo access, compilers and toolchains must be provisioned through the authorized executor; missing prerequisites are failures, not permission to install infrastructure.

Required warm-attach cases: held-ack/normal, lost-ack/normal, rejected-attach/normal, lost-ack/after-activation. All four must pass with existing authority retirement, event ownership, ACK, replay, delivery, process reuse and cleanup assertions. Required directory case: fails closed after a warm receipt rename when the parent-directory fsync fails. The script checks four passed warm cases, one passed directory case and all 16 selected scheduling cases; unselected tests in those files are not verification evidence. Preserve original test timeouts. Fixture subprocesses are test doubles only, not secondary workers.

The inherited 21 runner-fixture TypeScript diagnostics remain an explicit separate limit. Standard runner builds exclude that fixture. Its bytes are unchanged in this repair; prior explicit failed compiler receipts are retained internally. Do not interpret a standard build or Linux runtime pass as a fixture-inclusive compiler pass.
