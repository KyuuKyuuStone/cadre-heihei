/** Workspaces whose title marks them as internal must not appear as projects. */
export function isInternalWorkspaceTitle(title: string): boolean {
  return /（内部）|\(internal\)/iu.test(title)
}
