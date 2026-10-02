"""Add diagnostics only to a disposable checkout, requiring exact source anchors."""
import pathlib
import shutil
import sys

root = pathlib.Path(sys.argv[1]).resolve()
kind = sys.argv[2]
def replace_once(text, old, new):
    if text.count(old) != 1:
        raise SystemExit('Source anchor missing or ambiguous: ' + old[:80])
    return text.replace(old, new, 1)

if kind == 'runner':
    target = root / 'packages/paperclip-runner/src/live/runnerd-codex-transport.test.ts'
    text = target.read_text(encoding='utf-8')
    text = 'import * as diagnosticFs from "node:fs/promises";\n' + text
    old = '    removeRoot: () => rm(root, { recursive: true, force: true }),'
    new = '''    removeRoot: async () => {
      const destination = process.env.DIAGNOSTIC_OUTPUT!;
      await diagnosticFs.mkdir(destination, { recursive: true });
      await diagnosticFs.writeFile(join(destination, "runner-evidence.json"), JSON.stringify(bundle.evidence(), null, 2));
      for (const name of ["runner-state", "opencode"]) {
        const source = join(root, name);
        try { await diagnosticFs.cp(source, join(destination, name), { recursive: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      await rm(root, { recursive: true, force: true });
    },'''
    text = replace_once(text, old, new)
elif kind == 'browser':
    target = root / 'tests/e2e/signoff-policy.spec.ts'
    text = target.read_text(encoding='utf-8')
    text = 'import { observe, captureSignoff } from "./signoff-receipts";\n' + text
    text = replace_once(text, '  const run = await res.json();',
        '  const run = await res.json();\n  observe("invoke", { agentId, issueId, status: res.status(), response: run });')
    text = replace_once(text, '      const recentRuns = await recentRunsRes.json();',
        '      const recentRuns = await recentRunsRes.json();\n      observe("recent-run-candidates", { agentId, issueId, ids: Array.isArray(recentRuns) ? recentRuns.map((row) => row.id) : [] });')
    text = replace_once(text, '      const context = candidateRun.contextSnapshot ?? {};',
        '''      const context = candidateRun.contextSnapshot ?? {};
      observe("candidate", { issueId, requestedAgentId: agentId, id: candidateRun.id, agentId: candidateRun.agentId,
        status: candidateRun.status, wakeupRequestId: candidateRun.wakeupRequestId,
        boundIssueId: context.issueId, boundTaskId: context.taskId });''')
    text = replace_once(text, '  const issue = await res.json();\n  return {',
        '''  const issue = await res.json();
  observe("lock-state", { issueId, status: issue.status, assigneeAgentId: issue.assigneeAgentId,
    executionRunId: issue.executionRunId, checkoutRunId: issue.checkoutRunId, executionState: issue.executionState });
  return {''')
    text = replace_once(text, '    const board = ctx.boardRequest;\n',
        '    await captureSignoff(ctx.companyId, ctx.issueIds);\n    const board = ctx.boardRequest;\n')
    marker = '  test("review-only policy: reviewer approval completes execution",'
    if text.count(marker) != 1: raise SystemExit('Exact signoff case missing')
    before, exact_case = text.split(marker)
    exact_case = replace_once(exact_case, '    expect((await doneRes.json()).status).toBe("in_review");',
        '''    const reviewEntry = await doneRes.json();
    observe("review-entry", { issueId: issue.id, status: reviewEntry.status,
      assigneeAgentId: reviewEntry.assigneeAgentId, executionState: reviewEntry.executionState });
    expect(reviewEntry.status).toBe("in_review");''')
    text = before + marker + exact_case
    shutil.copyfile(pathlib.Path(__file__).with_name('signoff-receipts.ts'), target.with_name('signoff-receipts.ts'))
else:
    raise SystemExit('Unknown diagnostic kind')
target.write_text(text, encoding='utf-8', newline='\n')
print('Applied diagnostic capture:', kind)
