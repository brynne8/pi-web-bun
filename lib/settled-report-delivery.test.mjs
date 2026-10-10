import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { deliverSettledReport } = await jiti.import("./settled-report-delivery.ts");

const REPORT = { customType: "pi-web:bg-task-notification", content: "done", display: true };

/** A parent session: `running` decides its state, and the queue mode starts at pi's own default. */
function parentSession({ running, mode = "one-at-a-time", onSend }) {
  const sent = [];
  const listeners = [];
  const agent = { followUpMode: mode };
  return {
    sent,
    agent,
    listenerCount: () => listeners.length,
    emit: (event) => { for (const listener of listeners) listener(event); },
    session: {
      isAlive: () => true,
      isRunning: () => running,
      inner: {
        agent,
        sendCustomMessage: async (message, options) => {
          sent.push(options);
          if (onSend) onSend(sent.length, message, options);
        },
        subscribe: (listener) => { listeners.push(listener); return () => { listeners.splice(listeners.indexOf(listener), 1); }; },
      },
    },
  };
}

test("a report for a running parent is queued at once, with the whole queue drained together", async () => {
  // pi leaves the follow-up queue at `one-at-a-time`, which drains only the first message and
  // would wake the parent once per report. The mode is raised for the delivery so a burst lands
  // in one turn, and only for the delivery: the setting the pi CLI shares is never written.
  const parent = parentSession({ running: true });
  await deliverSettledReport(parent.session, REPORT);

  assert.equal(parent.sent.length, 1, "must not wait for the parent to fall idle");
  assert.deepEqual(parent.sent[0], { deliverAs: "followUp", triggerTurn: true });
  assert.equal(parent.agent.followUpMode, "all");
});

test("the queue mode is put back once the parent's run ends", async () => {
  const parent = parentSession({ running: true });
  await deliverSettledReport(parent.session, REPORT);
  assert.equal(parent.agent.followUpMode, "all");

  parent.emit({ type: "turn_end" });
  assert.equal(parent.agent.followUpMode, "all", "a turn ending is not the run ending");
  parent.emit({ type: "agent_end" });
  assert.equal(parent.agent.followUpMode, "one-at-a-time");
  assert.equal(parent.listenerCount(), 0, "the restore listener must not linger on the session");
});

test("two reports settling under the same run both reach the queue before the turn ends", async () => {
  const parent = parentSession({ running: true });
  await Promise.all([
    deliverSettledReport(parent.session, { ...REPORT, content: "first" }),
    deliverSettledReport(parent.session, { ...REPORT, content: "second" }),
  ]);

  assert.deepEqual(parent.sent, [
    { deliverAs: "followUp", triggerTurn: true },
    { deliverAs: "followUp", triggerTurn: true },
  ]);
  parent.emit({ type: "agent_end" });
  assert.equal(parent.agent.followUpMode, "one-at-a-time");
});

test("an idle parent is woken at once and its queue mode is left alone", async () => {
  const parent = parentSession({ running: false });
  await deliverSettledReport(parent.session, REPORT);

  assert.deepEqual(parent.sent, [{ deliverAs: "followUp", triggerTurn: true }]);
  assert.equal(parent.agent.followUpMode, "one-at-a-time");
  assert.equal(parent.listenerCount(), 0);
});

test("a run that started under the report is followed by a queued retry", async () => {
  // The parent can start a run between the state check and the send, and pi refuses the prompt
  // it is already busy with. It is streaming by then, which is the branch that queues.
  const parent = parentSession({ running: false, onSend: (n) => {
    if (n === 1) throw new Error("Agent is already processing a prompt. Use steer() or followUp() to queue messages.");
  } });
  await deliverSettledReport(parent.session, REPORT);

  assert.deepEqual(parent.sent, [
    { deliverAs: "followUp", triggerTurn: true },
    { deliverAs: "followUp", triggerTurn: false },
  ]);
});

test("any other send failure is reported instead of retried", async () => {
  const parent = parentSession({ running: true, onSend: () => { throw new Error("Session is being copied to a new session"); } });
  await assert.rejects(() => deliverSettledReport(parent.session, REPORT), /copied to a new session/);
  assert.equal(parent.sent.length, 1);
});

test("a parent that died while the report was in hand is skipped", async () => {
  const parent = parentSession({ running: false });
  const dead = { isAlive: () => false, isRunning: () => false, inner: parent.session.inner };
  await deliverSettledReport(dead, REPORT);
  assert.equal(parent.sent.length, 0);
});
