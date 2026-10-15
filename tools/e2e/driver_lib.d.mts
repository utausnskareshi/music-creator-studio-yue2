// Types of driver_lib.mjs (for the TypeScript unit test).
export interface Scenario {
  name: string;
  kind?: string;
  graph?: string;
  meta?: { repeat_of?: string; session_group?: string; expect?: { repeat_of?: string } } & Record<string, unknown>;
  uploads?: { path: string; name?: string; subfolder?: string }[];
  [k: string]: unknown;
}
export type ScenarioState = "none" | "changed" | "failed" | "same";
export function parseOpt(args: string[], k: string, d?: string): string | undefined;
export function unexpectedArgs(args: string[], opts: { values?: string[]; flags?: string[] }): string[];
export function parseOnly(raw: string | undefined, names: string[]): { only: string[]; unknown: string[] };
export function normalizeGraph<T>(graph: T): T;
export function sameGraph(a: unknown, b: unknown): boolean;
export function repeatOf(s: Scenario): string | null;
export function sessionGroup(s: Scenario): string | null;
export function missingUploads(s: Scenario, exists?: (p: string) => boolean): string[];
export function staleInputProblem(s: Scenario, exists?: (p: string) => boolean): string | null;
export function staleResultProblem(state: ScenarioState): string | null;
export const RUN_OUTPUTS: string[];
export function clearRunOutputs(resultDir: string): void;
export function resultState(resultDir: string, graph: unknown): ScenarioState;
export function promptQueued(queue: unknown, id: string): boolean | null;
export function runProblem(resultDir: string): string | null;
export function planRun(
  scenarios: Scenario[],
  opts: { only?: string[]; force?: boolean; retryFailed?: boolean; state: (s: Scenario) => ScenarioState },
): { todo: Scenario[]; changed: string[]; retried: string[]; dependents: string[]; dependentsSkipped: string[]; skipped: string[]; failed: string[] };
export function notRunAfterPass(
  plan: { skipped: string[]; failed: string[] },
  staleInputs: string[],
  inputGone: (name: string) => boolean,
  names: string[],
): { upToDate: string[]; failed: string[]; stale: string[] };
export function missingExpected(manifest: { scenarios?: Scenario[]; expected?: unknown[]; missing?: unknown[] }): { name: string; reason: string | null }[];
