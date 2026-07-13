import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSupervisor } from "../../src/codex/supervisor.js";

export async function runLiveAccountContract(codexHome: string) {
  const supervisor = createSupervisor({
    config: {
      codexBin: resolve("node_modules/.bin/codex"),
      codexHome,
    },
  });
  const cwd = mkdtempSync(join(tmpdir(), "live-chatgpt-contract-"));
  try {
    const host = await supervisor.start();
    const account = await host.accountRead(true);
    const models = await host.modelList({ includeHidden: false, limit: 100 });
    const model = models.data[0]?.model;
    if (!model) throw new Error("Live account returned no available model");
    const thread = await host.threadStart({
      model,
      cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
    });
    const events = host.events()[Symbol.asyncIterator]();
    await host.turnStart({
      threadId: thread.thread.id,
      input: [
        { type: "text", text: "Reply with the word ready.", text_elements: [] },
      ],
    });
    let text = "";
    for (;;) {
      const event = await events.next();
      if (event.done) throw new Error("Live App Server event stream ended");
      if (
        event.value.method === "item/completed" &&
        event.value.params.item.type === "agentMessage"
      ) {
        text = event.value.params.item.text;
      }
      if (event.value.method === "turn/completed") break;
    }
    const login = await host.loginStart({ type: "chatgptDeviceCode" });
    if (login.type === "chatgptDeviceCode") {
      await host.loginCancel({ loginId: login.loginId });
    }
    return {
      accountType: account.account?.type,
      models: models.data.length,
      text,
      deviceLoginType: login.type,
    };
  } finally {
    await supervisor.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
}
