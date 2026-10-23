/**
 * Keyless-by-default ACP snapshot suite factory. Each scenario drives the real
 * subprocess and compares normalized stdout; comparable session fixtures are
 * both replay input and expected output. Record mode refreshes reproducible
 * model scenarios from the live API, while refresh mode replays committed
 * scripts and rewrites derived artifacts without a key.
 * Replay scenarios run concurrently because each subprocess owns unique temp
 * cwd and persistence roots and reads only committed fixtures. Record and
 * refresh stay serial while writing.
 *
 * Exactly one scenario per header-composition class pins the tokenized header
 * sequence and the tokenized `system/message` sequence. Its prompt and
 * tool-schema sequences live in independent sidecars, each of which may be
 * shared with another class pin when the bytes are identical. Every live
 * header and system prompt is checked against the composed pin, so
 * session-dependent composition must declare a separate class instead of
 * escaping coverage.
 * @module @deepseek-ai/dsh-session-snapshot/suite
 */
import { type AgentUnderTest, type HarvestedLog } from './harness.ts';
import { type SnapshotSessionFormatManifest } from './manifest.ts';
import { type CwdPathMode, type NormalizeContext } from './normalize.ts';
/** A snapshot scenario and how its fixtures are produced. */
export interface Scenario {
    name: string;
    /** Deployment environment for this scenario's subprocess. */
    env?: NodeJS.ProcessEnv;
    /** Whether the scenario drives at least one model turn (so a JSONL expected output applies). */
    hasModelTurn: boolean;
    /**
     * Whether the run persists a comparable session log to diff against the
     * selected parent Session fixture. Defaults to {@link hasModelTurn} (a model turn
     * always produces a log worth comparing). Set it independently for a scenario
     * that produces a non-trivial durable log without calling the model.
     */
    comparesLog?: boolean;
    /**
     * Whether `test:snapshot:record` regenerates this scenario's current-version
     * Session fixtures from the LIVE API. `recorded` scenarios are model-driven and reproducible;
     * `authored` scenarios (fixtures hand-written or hand-harvested — e.g. a
     * provider error or a cancel the live API can't be coaxed into
     * deterministically, a deterministic hook scenario, or a scripted repetition
     * a live model won't reproduce) are NEVER re-recorded.
     */
    recorded: boolean;
    /** Historical generation retained as a read-only migration fixture. */
    sessionFormat?: SnapshotSessionFormatManifest;
    /**
     * Whether replay is driven by a hand-written `replay.override.json` sidecar
     * (a `ReplayOverrideDoc` that replaces or patches the script derived from
     * selected parent Session fixture) — the throw/hang cases chunks cannot express. The fixture
     * guard requires the sidecar exactly when this is set: the harness forwards
     * the file purely on existence, so an unregistered stray sidecar would
     * silently alter the derived script. The guard fails loud on either
     * mismatch. Defaults to false (replay derives from the fixture's
     * `assistant/chunk` events).
     */
    overridden?: boolean;
    /**
     * Whether this scenario is its header class's sole tokenized request-header
     * pin. Prompt and tool-schema sidecars are selected independently, while
     * every classmate is checked for equality with the reconstructed header.
     */
    pinsHeader?: boolean;
    /**
     * Header-pinning scenario whose `system-prompt.expected.md` this pin reuses.
     * Defaults to this scenario. The source must own its prompt sidecar and
     * declare the same {@link expectedPromptChanges}; only valid on a pin.
     */
    systemPromptSource?: string;
    /**
     * Header-pinning scenario whose `tool-schemas.expected.json` this pin reuses.
     * Defaults to this scenario. The source must own its schema sidecar and
     * declare the same {@link expectedHeaderChanges}; only valid on a pin.
     */
    toolSchemasSource?: string;
    /**
     * Child fixture indices whose own schema sequence is pinned separately,
     * where `1` names `session.1.jsonl` and
     * `tool-schemas.1.expected.json`. The class pin still owns every other
     * request-header field.
     */
    pinsChildToolSchemas?: readonly number[];
    /**
     * Child fixture indices whose own system prompt is pinned separately, where
     * `1` names `session.1.jsonl` and `system-prompt.1.expected.md`. A child
     * scope that installs its own prompt section (the continuable `report`
     * guidance) composes a prompt the class pin cannot describe.
     */
    pinsChildSystemPrompts?: readonly number[];
    /**
     * How many changed `request/header` snapshots this PINNING scenario's primary
     * fixture legitimately carries (default 0). Each change owns one more schema
     * set in the structured JSON pin; any other count fails. Only valid on the pin.
     */
    expectedHeaderChanges?: number;
    /**
     * How many later `system/message` events — replacements of surface node 0
     * or in-history appends — this PINNING scenario's primary fixture
     * legitimately carries after the initial prompt (default 0). Each change's
     * full prompt text is kept in the readable Markdown pin; any other count
     * fails. Only valid on the pin.
     */
    expectedPromptChanges?: number;
    /**
     * Which header-composition class this scenario belongs to. Scenarios that
     * boot the same config compose the same header; each class has exactly one
     * {@link pinsHeader} scenario, and the uniformity guard compares every
     * other member against ITS class's pin. Defaults to `'default'`; a
     * scenario booting an alternate config ({@link configPath}) whose tool
     * list or prompt sections differ by construction carries its own class.
     */
    headerClass?: string;
    /**
     * Alternate live profile patch (absolute) this scenario boots instead of
     * {@link AgentUnderTest.configPath}. Its basename must still end in
     * `cordis.yml` so the launcher finds the replay sibling. A scenario whose
     * patch changes the composed header also needs its own
     * {@link headerClass}.
     */
    configPath?: string;
    /**
     * Parent directory for the generated session cwd. Defaults to the platform
     * temp directory; set this when temp is itself part of the behavior under
     * test and the scenario needs an independent project location.
     */
    workspaceParent?: string;
    /**
     * Optional final workspace preparation after the committed fixture is
     * copied. Reserve this for paths that Git cannot represent portably; normal
     * scenario files belong under the scenario's `workspace/` directory.
     */
    prepareWorkspace?: (cwd: string) => void | Promise<void>;
    /**
     * Whether Windows additionally compares stdout with native separators against
     * `stdout.expected.windows.jsonl`. The shared canonical stdout expected output is still
     * compared on every platform, and the fixture guard requires this sidecar
     * exactly when the option is set.
     */
    pinsNativeWindowsStdout?: boolean;
    /**
     * Whether the scenario requires a non-Windows host, such as for POSIX process
     * semantics or generated paths Windows cannot represent. The scenario's run
     * test is skipped on Windows; its fixtures stay guarded on every platform.
     */
    posixOnly?: boolean;
    /**
     * Whether the scenario boots a composition that needs a usable `pwsh`
     * (the pwsh-tool-turn scenario). The run test is skipped when the suite's
     * {@link SnapshotSuiteOptions.hasPwsh} probe is false; fixtures stay guarded
     * on every platform.
     */
    pwshOnly?: boolean;
}
/**
 * Whether a scenario's run test is skipped for this mode and host: record mode
 * skips authored (non-`recorded`) scenarios and explicit historical Session
 * generations, {@link Scenario.posixOnly} scenarios skip on Windows, and
 * {@link Scenario.pwshOnly} scenarios skip when the caller's `hasPwsh` probe
 * is false.
 *
 * @param scenario The scenario whose run test is being registered.
 * @param recording Whether the suite runs in record mode.
 * @param platform The running Node platform, injectable for unit coverage.
 * @param hasPwsh The caller's pwsh-availability probe; `pwshOnly` scenarios
 *   skip unless it is true.
 * @returns True when the scenario's run test must not execute.
 */
export declare function scenarioSkipped(scenario: Scenario, recording: boolean, platform?: NodeJS.Platform, hasPwsh?: boolean): boolean;
/** One stdout expected output selected for a platform run. */
interface StdoutExpectedVariant {
    file: string;
    cwdPathMode: CwdPathMode;
}
/**
 * Select the shared stdout expected output plus any platform-native assertion declared by a scenario.
 *
 * @param scenario The scenario whose stdout contract is being selected.
 * @param platform The running Node platform, injectable for unit coverage.
 * @returns The ordered expected-output variants: shared canonical first, then optional Windows native.
 */
export declare function stdoutExpectedVariants(scenario: Scenario, platform?: NodeJS.Platform): StdoutExpectedVariant[];
/** One suite's inputs: the agent to boot, where its fixtures live, and its scenario table. */
export interface SnapshotSuiteOptions {
    /** The agent composition every scenario boots. */
    agent: AgentUnderTest;
    /** Absolute path of the suite's `snapshots/` directory (one subdir per scenario). */
    snapshotsDir: string;
    /** The scenario table; exactly one entry per header class must set `pinsHeader`. */
    scenarios: Scenario[];
    /**
     * `replay` (keyless, the default tier), `record` (live API; re-records the
     * `recorded` scenarios' fixtures and refreshes the Vitest expected outputs under
     * `--update`), or `refresh` (keyless replay that rewrites stdout expected outputs and
     * comparable session fixtures from the replay run). The caller derives this
     * from `$DSH_SNAPSHOT` — env reading stays outside this library.
     */
    mode: 'replay' | 'record' | 'refresh';
    /**
     * Whether a real `pwsh` executable is available on this host (the probe the
     * caller owns; `pwshOnly` scenarios skip when this is not true).
     */
    hasPwsh?: boolean;
}
/** One scenario's generated claim on a shared snapshot file. */
export interface SharedSnapshotClaim {
    /** Scenario that first generated the snapshot in this suite run. */
    scenario: string;
    /** Complete generated file content. */
    content: string;
}
/** One committed snapshot file and its complete content. */
export interface NamedSnapshotContent {
    /** Diagnostic path of the committed file. */
    path: string;
    /** Complete committed file content. */
    content: string;
}
/**
 * Record one scenario's generated content for a shared snapshot source.
 * A later claimant must generate identical bytes; otherwise record/refresh
 * would make the final file depend on scenario order.
 *
 * @param claims Claims already made in this suite run, keyed by source path.
 * @param source The shared snapshot path being claimed.
 * @param scenario The scenario generating the content.
 * @param content The complete content the scenario generated.
 * @returns Nothing.
 */
export declare function claimSharedSnapshot(claims: Map<string, SharedSnapshotClaim>, source: string, scenario: string, content: string): void;
/**
 * Reject byte-identical committed snapshots stored under different paths.
 *
 * @param kind Human-readable snapshot kind for the diagnostic.
 * @param snapshots The committed files to compare.
 * @returns Nothing.
 */
export declare function assertUniqueSnapshotContents(kind: string, snapshots: readonly NamedSnapshotContent[]): void;
/**
 * Derive normalization values from a fixture's own session header. Recorded ids and cwd differ
 * from the live replay run; the non-empty sentinel for missing cwd avoids accidental empty-
 * string replacement.
 *
 * @param fixture The selected committed parent Session fixture content.
 * @returns The fixture's own volatile values, ready for {@link normalizeSessionLog}.
 */
export declare function fixtureContext(fixture: string): NormalizeContext;
/**
 * The `data.header` payload of every `request/header` event in a session
 * JSONL, in log order, with the log's volatile values scrubbed first
 * ({@link normalizeSessionLog}) so headers harvested from different runs —
 * each embedding its own generated cwd — compare on equal footing.
 *
 * @param rawLog The session `.jsonl` content to extract headers from.
 * @param ctx The volatile values of the run that produced it.
 * @returns The normalized `data.header` payloads, in log order.
 */
export declare function normalizedHeaders(rawLog: string, ctx: NormalizeContext): unknown[];
/**
 * The normalized prompt text of every `system/message` event in a session
 * JSONL, in log order: the first is the initial system prompt (surface node 0)
 * and each later one replaced it or, on an in-history route, appended the
 * changed prompt after the cached history. An empty `content` yields `''`; a
 * `system/message` without a text block is omitted.
 *
 * @param rawLog The session `.jsonl` content to inspect.
 * @param ctx The volatile values of the run that produced it.
 * @returns The normalized system prompts, in log order.
 */
export declare function normalizedSystemPrompts(rawLog: string, ctx: NormalizeContext): string[];
/**
 * Whether every model request in a session JSONL is preceded by its system
 * prompt: the log has no `request/header`, or a `system/message` event comes
 * before its first `request/header`.
 *
 * @param rawLog The session `.jsonl` content to inspect.
 * @returns True when the first `request/header` (if any) follows a `system/message`.
 */
export declare function systemPromptPrecedesRequests(rawLog: string): boolean;
/**
 * The normalized tool-schema arrays carried by request headers in a session
 * JSONL, in log order. Headers without an array-valued tools field are omitted
 * so callers can assert one schema set per header explicitly.
 *
 * @param rawLog The session `.jsonl` content to inspect.
 * @param ctx The volatile values of the run that produced it.
 * @returns The normalized initial tool-schema arrays, in header order.
 */
export declare function normalizedToolSchemas(rawLog: string, ctx: NormalizeContext): unknown[][];
/** The structured contents of a tool-schema sidecar. */
export interface ToolSchemasSnapshot {
    /** The complete tool schemas from the pinned request header. */
    initial: unknown[];
    /** Complete tool schemas from subsequent changed-header snapshots. */
    changes: unknown[][];
}
/**
 * Render the full tool-schema sequence as canonical, readable JSON.
 *
 * @param initial The pinned request header's complete tool schemas.
 * @param changes Complete tool schemas from later changed headers.
 * @returns A pretty-printed JSON snapshot ending in one newline.
 */
export declare function formatToolSchemasSnapshot(initial: readonly unknown[], changes?: readonly unknown[][]): string;
/**
 * Parse and validate the stable top-level fields of a tool-schema sidecar.
 *
 * @param snapshot The JSON sidecar text.
 * @returns Its initial and changed-header schema sets.
 */
export declare function parseToolSchemasSnapshot(snapshot: string): ToolSchemasSnapshot;
/**
 * Restore one sidecar schema set into a tokenized pinned header.
 *
 * @param header The parsed request header carrying a tools token or ordered tool names matching the sidecar.
 * @param schemas The complete schemas for this full header snapshot.
 * @returns A copy of the header with its complete schemas restored.
 */
export declare function restorePinnedToolSchemas(header: unknown, schemas: readonly unknown[]): unknown;
/**
 * Render a normalized prompt as a repository-friendly Markdown snapshot.
 * Prompt text is unchanged except that a missing terminal newline is added so
 * the committed file follows the repository newline contract.
 *
 * @param prompt The normalized initial system prompt (surface node 0).
 * @param changes Full normalized prompts from later `system/message` events, replacements or in-history appends.
 * @returns Markdown snapshot text ending in a newline.
 */
export declare function formatSystemPromptSnapshot(prompt: string, changes?: readonly string[]): string;
/**
 * Split a prompt sidecar into its initial prompt and each later change, the
 * inverse of {@link formatSystemPromptSnapshot}.
 *
 * @param snapshot The Markdown sidecar text.
 * @returns The initial prompt snapshot plus one entry per later `system/message`.
 */
export declare function parseSystemPromptSnapshot(snapshot: string): {
    initial: string;
    changes: string[];
};
/**
 * Reject a child prompt sidecar that cannot own distinct, canonical prompt text.
 * @param sidecar - committed child prompt snapshot.
 * @param classPin - initial prompt snapshot owned by the scenario's header class.
 * @param label - repository-relative fixture label for diagnostics.
 */
export declare function assertChildSystemPromptSnapshot(sidecar: string, classPin: string, label: string): void;
/**
 * Count changed `request/header` snapshots in a session JSONL.
 *
 * @param rawLog The session `.jsonl` content.
 * @returns How many headers carry reason `change`.
 */
export declare function headerChangeCount(rawLog: string): number;
/** A literal replacement from a fresh replay-run volatile to its existing fixture value. */
export interface FixtureReplacement {
    /** The fresh replay run's volatile value. */
    from: string;
    /** The existing fixture value retained during write-back. */
    to: string;
}
/**
 * Carry committed UUIDs into unchanged, unambiguous messages in fresh session fixtures.
 *
 * @param logs Fresh fixture-ready session JSONL contents for one scenario.
 * @param fixtures Existing fixture contents in matching order; missing fixtures may be empty strings.
 * @returns The fresh contents with only reusable message UUIDs replaced.
 */
export declare function stabilizeFixtureMessageIds(logs: readonly string[], fixtures: readonly string[]): string[];
/**
 * Find tool calls whose structured result reports `UNKNOWN_TOOL`.
 *
 * Snapshot refresh must not turn a missing registration into accepted behavior;
 * intentional unknown-tool behavior belongs in a focused unit or e2e test.
 *
 * @param rawLog The session JSONL to inspect.
 * @returns The failing call ids in log order, using a diagnostic placeholder when absent.
 */
export declare function unknownToolCallIds(rawLog: string): string[];
/**
 * Build refresh write-back replacements for per-log session ids, cwd values,
 * and spill paths. Durable message ids have a later structural owner.
 *
 * @param logs The freshly harvested logs, in fixture order.
 * @param fixtures The existing fixture contents, in matching order.
 * @returns Literal replacements from fresh values to the fixture's existing values.
 */
export declare function refreshFixtureReplacements(logs: HarvestedLog[], fixtures: string[]): FixtureReplacement[];
/**
 * Check raw parent/child clocks before normalization, or preserve their equality during refresh.
 * @param logs - one scenario's parent and child logs with shared Session ids.
 * @param policy - validate live output, or align refreshed catalogs to the retained child headers.
 * @returns logs with only conflicting catalog creation times replaced under preserve-headers.
 */
export declare function reconcileCatalogCreationTimes(logs: readonly string[], policy: 'validate' | 'preserve-headers'): string[];
/**
 * Rewrite a fresh replay-produced log so repeated refreshes do not churn
 * volatile fixture fields. Meaningful event payloads come from `fresh`; the
 * existing fixture lends normalized-equivalent values, including non-message ids, paths,
 * creation/event times, spill locators, and hook durations, only when the
 * complete record layout aligns and volatile strings form a consistent
 * bijection. Complete durable-message ids are excluded because the later
 * fixture-ready structural pass owns them. Ambiguous layouts or mappings
 * keep fresh strings. Packed timing gaps expand from zero when a projected
 * fixture omits `time0`, so packing does not shift later records;
 * fresh semantic values and fragment arrays remain authoritative.
 *
 * @param fresh The newly harvested session JSONL.
 * @param existing The committed fixture JSONL being refreshed.
 * @param replacements Cross-log literal replacements from {@link refreshFixtureReplacements}.
 * @param freshContext The harvested run's ids, cwd, and every cwd alias.
 * @returns The stabilized JSONL content to write back.
 */
export declare function stabilizeRefreshLog(fresh: string, existing: string, replacements: FixtureReplacement[], freshContext: NormalizeContext): string;
/**
 * Check every selected role for tool/path defects and current generations for canonical prompt/identity storage.
 * Historical roles retain their released bytes, including roles retired by the current writer.
 * @param dir Scenario directory containing canonical Session fixtures.
 * @param scenarioName Scenario name used in failure diagnostics.
 * @returns Resolves when all selected fixtures satisfy the storage checks.
 */
export declare function assertSessionFixtureStorage(dir: string, scenarioName: string): Promise<void>;
/**
 * Register the suite: one test per scenario (the expected-output and log comparisons and
 * the header and prompt uniformity guard) plus the fixture guard block (no orphan
 * scenario dirs, required files present, exactly one pin per header class,
 * shared sidecars unique and well-formed, every JSONL prompt- and
 * schema-scrubbed with a `system/message` before its first request). Must
 * run at vitest collection time — it calls `describe`/`it`. Throws
 * immediately if any header class lacks a pinning scenario or carries two
 * (the uniformity guard needs exactly one comparison anchor per class).
 *
 * @param options The agent, snapshots directory, scenario table, and mode.
 */
export declare function defineAcpSnapshotSuite(options: SnapshotSuiteOptions): void;
export {};
//# sourceMappingURL=suite.d.ts.map