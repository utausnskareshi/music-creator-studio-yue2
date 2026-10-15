import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import type { LlmStatus } from "../../api";
import { llmStatusLabel } from "../SettingsPage";

const status = (s: Partial<LlmStatus>): LlmStatus => ({
  provider: "local",
  processRunning: false,
  alive: false,
  port: 8099,
  model: null,
  hasAnthropicKey: false,
  hasOpenaiKey: false,
  localModels: [],
  external: false,
  restartRequired: false,
  openaiKeyOrigin: null,
  ...s,
});

describe("local LLM status line", () => {
  it("counts this app's server as running while its process runs, as AI 編集 does", () => {
    expect(llmStatusLabel(status({ processRunning: true, alive: true }))).toBe("稼働中");
    // the model is still loading: /health does not answer yet
    expect(llmStatusLabel(status({ processRunning: true }))).toBe("起動中");
    // still on the port from before a change (the next AI request restarts it)
    expect(llmStatusLabel(status({ processRunning: true, restartRequired: true }))).toBe("稼働中（変更前の設定）");
  });

  it("names a server this app did not start, and a stopped or unknown one", () => {
    expect(llmStatusLabel(status({ alive: true, external: true }))).toBe("稼働中（このアプリが起動していない llama-server）");
    expect(llmStatusLabel(status({}))).toBe("停止");
    expect(llmStatusLabel(null)).toBe("停止");
  });
});
