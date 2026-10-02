// Append to durable-prp-control-plane.test.ts to reuse authenticated fake peers.
it.each(["before", "after"] as const)(
  "captures old warm authority when the observer runs %s activation",
  async (observerOrder) => {
    const root = mkdtempSync(resolve(tmpdir(), "warm-observer-order-"));
    const core = new DurablePrpControlPlane({
      stateDirectory: root, identity, expectedRunnerVersion, expectedRunnerDigest,
    });
    const nextIdentity = { ...identity,
      runId: "00000000-0000-4000-8000-000000000002",
      turnId: "observer-next-turn", itemId: "observer-next-item" };
    const store = core.store as typeof core.store & {
      commit(candidate: typeof core.store.state): void;
    };
    const commit = store.commit.bind(store);
    const retired: (typeof store.state)[] = [];
    const spy = vi.spyOn(store, "commit").mockImplementation((candidate) => {
      const previous = candidate.identity.runId !== store.state.identity.runId
        ? structuredClone(store.state) : null;
      commit(candidate);
      if (previous) retired.push(previous);
    });
    let peer: AuthenticatedClient | null = null;
    let successor: AuthenticatedClient | null = null;
    try {
      await core.start();
      peer = (await authenticate(core, core.issueBootstrapTicket()))!;
      const oldToken = peer.leaseToken!;
      const command = core.queueCommand("run.attach", {
        paperclipNextAuthority: { identity: nextIdentity,
          connection: { mode: "connect", connectUrl: core.connectUrl } },
      }, "observer-order-attach", true);
      await expect(receiveSecure(peer)).resolves.toMatchObject({ kind: "command" });
      const event = semanticInputEvent();
      event.payload = { ...(event.payload as Record<string, unknown>),
        eventType: "run.attached", priority: 0, payload: {} };
      sendSecure(peer, event);
      // Respect the real Rust runner's old-authority outbox ACK barrier.
      await expect(receiveSecure(peer)).resolves.toMatchObject({
        kind: "ack", payload: { ackedSourceSeq: 1 } });
      sendSecure(peer, { protocol: "paperclip.runner", version: 1,
        kind: "command_result", payload: { commandId: command.commandId,
          commandType: command.type, controllerSeq: command.controllerSeq,
          status: "completed", result: { attached: true } } });
      const ack = await receiveSecure(peer);
      const receipt = (ack!.payload as Record<string, unknown>).warmTransition as Record<string, unknown>;
      let observerSnapshot: typeof store.state | undefined;
      const observe = () => {
        observerSnapshot = structuredClone(store.state);
        core.rotateRunIdentity(nextIdentity);
      };
      if (observerOrder === "before") observe();
      peer.socket.destroy();
      successor = await authenticate(core, oldToken, nextIdentity,
        expectedRunnerDigest, receipt.transitionId as string);
      expect(successor).not.toBeNull();
      if (observerOrder === "after") observe();
      expect(store.state.identity).toEqual(nextIdentity);
      expect(retired).toHaveLength(1);
      expect(retired[0]!.identity).toEqual(identity);
      const attached = retired[0]!.committedEvents.find((entry) => entry.sourceEventId === "semantic-event-1");
      expect(attached?.logicalEffectCount).toBe(1);
      expect(retired[0]!.ackedSourceSeq).toBeGreaterThanOrEqual(attached!.sourceSeq);
      expect(retired[0]!.warmTransition?.receipt.oldAckedSourceSeq).toBe(1);
      const legacyEvent = observerSnapshot!.committedEvents.find((entry) => entry.sourceEventId === "semantic-event-1");
      console.log("OBSERVER_ORDER_RECEIPT", JSON.stringify({ observerOrder,
        observedRunId: observerSnapshot!.identity.runId, legacyEventPresent: !!legacyEvent,
        retiredRunId: retired[0]!.identity.runId, committedEventPresent: !!attached,
        oldAckedSourceSeq: retired[0]!.ackedSourceSeq }));
      if (observerOrder === "after") {
        expect(legacyEvent).toBeUndefined();
        expect(() => legacyEvent!.logicalEffectCount).toThrow(TypeError);
      } else expect(legacyEvent!.logicalEffectCount).toBe(1);
    } finally {
      peer?.socket.destroy(); successor?.socket.destroy();
      await core.stop(); await core.drainPendingConnectionProcessing();
      spy.mockRestore(); rmSync(root, { recursive: true, force: true });
    }
  },
);
