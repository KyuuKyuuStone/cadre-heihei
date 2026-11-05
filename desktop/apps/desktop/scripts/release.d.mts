/** Packaging artifacts the release verify step checks. */
export interface ReleaseVerifyResult {
  /** False when any problem was found; the release stops before publishing. */
  readonly ok: boolean
  /** The problems found, each naming what failed. */
  readonly problems: string[]
  /** Size of the verified executable in bytes. */
  readonly bytes: number
}

/**
 * Find secret-like API-key tokens in packaged bytes.
 *
 * A key is a standalone token: the `sk-` prefix must start a word, so a
 * documentation anchor whose text merely contains "sk-" inside a longer word
 * (`mask-output-offset-length`) is not reported, while a real key is.
 * @param text - Packaged text to scan.
 * @returns The secret-like tokens found.
 */
export function findSecretLikeKeys(text: string): string[]

/**
 * Check one packaged artifact against the release expectations.
 * @param version - Version the artifact must declare.
 * @param exePath - Path of the built executable.
 * @param artifactsRoot - Directory holding the artifact and its unpacked tree.
 * @returns The problems found, the checks that passed, and the artifact size.
 */
export function verifyArtifacts(version: string, exePath: string, artifactsRoot?: string): ReleaseVerifyResult
