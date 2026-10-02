"""Prepare a disposable fixed-pin checkout; no network, credentials or product edits."""
import pathlib
import sys

root = pathlib.Path(sys.argv[1]).resolve()
variant = sys.argv[2]
if variant not in ('baseline', 'candidate'):
    raise SystemExit('Unknown diagnostic variant')
package = pathlib.Path(__file__).parent
target = root / 'packages/paperclip-runner/src/live/runnerd-codex-transport.test.ts'
text = target.read_text(encoding='utf-8')
start = text.index('it.each(["held-ack", "lost-ack", "rejected-attach"] as const)(')
end = text.index('\nit.each(', start + 10)
before, exact, after = text[:start], text[start:end], text[end:]

def once(old, new):
    global exact
    if exact.count(old) != 1:
        raise SystemExit('Missing or ambiguous anchor: ' + old[:80])
    exact = exact.replace(old, new, 1)

# Safe summaries only: no private fixture lease or authentication material.
once('  async (mode) => {', '''  async (mode) => {
    const summarize = (state: DurablePrpControlPlane["store"]["state"]) => ({
      identity: state.identity, ackedSourceSeq: state.ackedSourceSeq,
      connectionCount: state.connectionCount,
      events: state.committedEvents.map((entry) => ({
        id: entry.sourceEventId, seq: entry.sourceSeq, type: entry.eventType,
        effectCount: entry.logicalEffectCount, runId: entry.envelope.runId,
      })),
      phase: state.warmTransition?.phase ?? null,
      transitionOldAck: state.warmTransition?.receipt.oldAckedSourceSeq ?? null,
    });
    const observations: unknown[] = [];''')
once('        cores.push(core);', '''        const observedStore = core.store as typeof core.store & {
          commit(candidate: typeof core.store.state): void;
        };
        const durableCommit = observedStore.commit.bind(observedStore);
        observedStore.commit = (candidate) => {
          const previous = summarize(observedStore.state);
          durableCommit(candidate);
          if (candidate.identity.runId !== previous.identity.runId)
            observations.push({ boundary: "durable-retirement", previous, next: summarize(candidate) });
        };
        cores.push(core);''')
once('          rotations.push(structuredClone(core.store.state));', '''          observations.push({ boundary: "attach-observer", state: summarize(core.store.state) });
          rotations.push(structuredClone(core.store.state));''')
once('      armed = true;', '''      if (process.env.WARM_OBSERVER_ORDER === "after-activation") {
        const getCommand = core.getCommand.bind(core);
        vi.spyOn(core, "getCommand").mockImplementation((id) => {
          const command = getCommand(id);
          // Delay only the observer's polling view, never durable state or ACKs.
          if (command?.type === "run.attach" && command.status === "completed" &&
              core.store.state.identity.runId === oldIdentity.runId)
            return { ...command, status: "pending" };
          return command;
        });
      }
      armed = true;''')
once('      releaseCommit();\n      try {', '''      releaseCommit();
      const diagnosticDirectory = process.env.DIAGNOSTIC_OUTPUT!;
      try {
        await mkdir(diagnosticDirectory, { recursive: true });
        await writeFile(join(diagnosticDirectory, mode + ".json"), JSON.stringify({
        mode, observerOrder: process.env.WARM_OBSERVER_ORDER ?? "natural",
        error: primaryError instanceof Error ? primaryError.stack : null,
        heldEventId: heldEvent?.sourceEventId,
        heldEventDeliveries: heldEvent ? effects.get(heldEvent.sourceEventId)?.deliveries : null,
        observations,
        }, null, 2));
      } catch (captureError) {
        console.error("Diagnostic capture failed", captureError);
      }
      try {''')
target.write_text(before + exact + after, encoding='utf-8', newline='\n')
controller = root / 'packages/paperclip-runner/src/control-plane/durable-prp-control-plane.test.ts'
with controller.open('a', encoding='utf-8', newline='\n') as stream:
    stream.write('\n' + (package / 'observer-order-diagnostic.ts').read_text(encoding='utf-8'))
print('Prepared bounded warm-attach diagnostics:', variant)
