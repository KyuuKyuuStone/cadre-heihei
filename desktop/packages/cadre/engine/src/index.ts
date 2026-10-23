/**
 * EnginePort interface entry: the four-port surface shared by both bindings.
 * Bindings live in `./client` (official Client Remote) and `./host` (official
 * Host services); this entry is type-only on purpose so a bundler never pulls
 * one face through the other.
 *
 * @module @deepseek-ai/dsh-cadre-engine
 */
export type * from './types.ts'
