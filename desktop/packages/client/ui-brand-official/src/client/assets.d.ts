/** Seal artwork imports are embedded in the brand client bundle. */
declare module '*.svg' {
  const url: string
  export default url
}
