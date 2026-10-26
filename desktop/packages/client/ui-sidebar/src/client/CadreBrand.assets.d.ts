/** Seal artwork imports are embedded in the sidebar client bundle. */
declare module '*.svg' {
  const url: string
  export default url
}
