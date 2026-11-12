/** Dedicated Electron session for the owned Host loopback; never uses the system proxy. */
import { session, type Session } from 'electron'

/**
 * In-memory partition for Host loopback traffic. `persist:` is intentionally
 * absent: the Host launch cookie is single-run authority and must not survive
 * an app restart.
 */
export const LOOPBACK_SESSION_PARTITION = 'dsh-host-loopback'

/**
 * Open the partition used by every loopback Host request.
 *
 * Chromium applies system proxy settings to `net.fetch` and `session.fetch`.
 * A direct-proxy session keeps `127.0.0.1`/`localhost` off a system proxy
 * without changing the default session that `electron-updater` uses.
 * @returns Session whose proxy mode is direct and whose HTTP cache is disabled.
 */
export async function openLoopbackSession(): Promise<Session> {
  const loopback = session.fromPartition(LOOPBACK_SESSION_PARTITION, { cache: false })
  // Await before the first request: auth must not race the proxy switch.
  await loopback.setProxy({ mode: 'direct' })
  return loopback
}

/**
 * Read the cookies the Host issued through the loopback session.
 * @param loopback - Dedicated Host loopback session.
 * @param url - Host launch URL whose authority scopes the cookies.
 * @returns Cookie request header, or an empty string when the Host issued none.
 */
export async function readLoopbackCookies(loopback: Session, url: string): Promise<string> {
  const cookies = await loopback.cookies.get({ url })
  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
}
