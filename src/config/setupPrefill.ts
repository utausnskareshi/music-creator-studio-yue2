/**
 * Locations typed in Settings before 「セットアップをやり直す」. config.json keeps the working install's
 * locations when the wizard opens (so its 「アプリに戻る」 goes back to that install); these values only
 * pre-fill the wizard's 保存場所 step and are saved there with 「次へ」. In memory only: an app restart opens
 * the wizard with the stored locations.
 */
export interface SetupLocations {
  dataRoot: string;
  outputDir: string;
}

let pending: SetupLocations | null = null;

/** Set (or with null clear) the locations the next wizard pre-fills. */
export function setSetupPrefill(locations: SetupLocations | null): void {
  pending = locations ? { ...locations } : null;
}

/** The pending locations, left in place (a React initializer may run twice). */
export function peekSetupPrefill(): SetupLocations | null {
  return pending ? { ...pending } : null;
}

/** Forget the pending locations (the wizard calls this once it has mounted). */
export function clearSetupPrefill(): void {
  pending = null;
}
