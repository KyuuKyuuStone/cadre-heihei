/** Immutable Session-generation filenames used by recorded-session fixtures. */
import { basename, dirname } from 'node:path';
import { parseSessionFormatLogFilename, sessionFormatLogFilename } from '@deepseek-ai/dsh-session-format';
const FIXTURE_FILE = /^session(?:\.([1-9]\d*))?(?:\.v([1-9]\d*))?\.jsonl$/u;
function nonNegativeSafeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
        throw new Error(`${label} must be a non-negative safe integer`);
    }
}
/**
 * Return the canonical fixture filename for one parent/ordinal and generation.
 *
 * @param index - Parent `0` or a positive child/ordinal slot.
 * @param version - Physical format generation; `0` is omitted.
 * @returns The lowercase canonical JSONL filename.
 */
export function sessionFixtureName(index, version) {
    nonNegativeSafeInteger(index, 'session fixture index');
    nonNegativeSafeInteger(version, 'Session format version');
    const ordinal = index === 0 ? '' : `.${index}`;
    const generation = version === 0 ? '' : `.v${version}`;
    return `session${ordinal}${generation}.jsonl`;
}
/**
 * Name the native-writer oracle for a retained historical replay role.
 * This expected output never participates in replay generation selection.
 * @param index - Parent `0` or a positive child/ordinal slot.
 * @returns The expected-output JSONL basename.
 */
export function writerSnapshotName(index) {
    nonNegativeSafeInteger(index, 'writer snapshot index');
    return `writer${index === 0 ? '' : `.${index}`}.expected.jsonl`;
}
/**
 * Parse one canonical recorded-session fixture filename.
 *
 * @param name - Basename from a scenario directory.
 * @returns Parsed role and generation, or `undefined` for an unrelated file.
 */
export function parseSessionFixtureName(name) {
    const match = FIXTURE_FILE.exec(name);
    if (match === null) {
        if (name.startsWith('session') && name.endsWith('.jsonl')) {
            throw new Error(`invalid session fixture name: ${name}`);
        }
        return undefined;
    }
    const index = match[1] === undefined ? 0 : Number(match[1]);
    const version = match[2] === undefined ? 0 : Number(match[2]);
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(version)) {
        throw new Error(`invalid session fixture name: ${name}`);
    }
    return { index, version, name };
}
/**
 * Select the highest generation for every parent/ordinal fixture role.
 * Older generations remain in the directory but do not count as extra Sessions.
 *
 * @param names - File basenames in one scenario directory.
 * @returns Parent first, followed by contiguous child/ordinal roles.
 */
export function sessionFixtureFiles(names) {
    const selected = new Map();
    const identities = new Set();
    for (const name of names) {
        const fixture = parseSessionFixtureName(name);
        if (fixture === undefined)
            continue;
        const identity = `${fixture.index}/${fixture.version}`;
        if (identities.has(identity))
            throw new Error(`duplicate session fixture generation: ${name}`);
        identities.add(identity);
        const previous = selected.get(fixture.index);
        if (previous === undefined || fixture.version > previous.version)
            selected.set(fixture.index, fixture);
    }
    const primary = selected.get(0);
    if (primary === undefined)
        throw new Error('missing parent session fixture');
    const ordered = [...selected.values()].sort((left, right) => left.index - right.index);
    for (const [offset, fixture] of ordered.entries()) {
        if (fixture.index !== offset) {
            throw new Error(`session fixture roles must be contiguous: expected index ${offset}, found ${fixture.name}`);
        }
    }
    return ordered;
}
/**
 * Validate and order a scenario directory's selected Session fixture filenames.
 *
 * @param names - File basenames in one scenario directory.
 * @returns Highest-generation parent and child/ordinal filenames.
 */
export function sessionFixtureNames(names) {
    return sessionFixtureFiles(names).map(file => file.name);
}
/**
 * Read the declared physical generation from one Session JSONL header.
 *
 * @param content - Complete UTF-8 JSONL content.
 * @param label - Diagnostic filename or path.
 * @returns The declared non-negative format generation.
 */
export function sessionHeaderVersion(content, label) {
    const line = content.split(/\r?\n/u).find(candidate => candidate.trim().length > 0);
    if (line === undefined)
        throw new Error(`${label}: session fixture is empty`);
    let value;
    try {
        value = JSON.parse(line);
    }
    catch (error) {
        throw new Error(`${label}: session header contains invalid JSON`, { cause: error });
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || value.type !== 'session') {
        throw new Error(`${label}: first record must be a Session header`);
    }
    const version = value.version;
    if (!Number.isSafeInteger(version) || version < 0 || Object.is(version, -0)) {
        throw new Error(`${label}: Session header version must be a non-negative safe integer`);
    }
    return version;
}
/**
 * Require one fixture's canonical filename generation to equal its header.
 *
 * @param name - Canonical fixture basename.
 * @param content - Complete UTF-8 JSONL content.
 * @returns The validated format generation.
 */
export function assertSessionFixtureVersion(name, content) {
    const fixture = parseSessionFixtureName(name);
    if (fixture === undefined)
        throw new Error(`not a session fixture name: ${name}`);
    const first = content.split(/\r?\n/u).find(candidate => candidate.trim().length > 0);
    if (first !== undefined) {
        let projected;
        try {
            projected = JSON.parse(first);
        }
        catch {
            projected = undefined;
        }
        if (projected !== null && typeof projected === 'object' && !Array.isArray(projected)
            && projected.type === 'session'
            && !Object.hasOwn(projected, 'version')) {
            if (fixture.version !== 0) {
                throw new Error(`${name}: a versionless projected Session header is format v0`);
            }
            return 0;
        }
    }
    const headerVersion = sessionHeaderVersion(content, name);
    if (headerVersion !== fixture.version) {
        throw new Error(`${name}: filename declares Session format v${fixture.version}, header declares v${headerVersion}`);
    }
    return headerVersion;
}
/**
 * Return the canonical persistence basename for one generation and compression.
 *
 * @param version - Physical format generation; `0` is omitted.
 * @param compression - Backend compression mode.
 * @returns The canonical persistence basename.
 */
export function persistedSessionFilename(version, compression = 'raw') {
    return `${sessionFormatLogFilename(version)}${compression === 'zstd' ? '.zstd' : ''}`;
}
/**
 * Parse a canonical persistence basename from a Session's own directory.
 *
 * @param name - Candidate basename.
 * @returns Its generation and compression, or `undefined` for noise and noncanonical names.
 */
export function parsePersistedSessionFilename(name) {
    const compression = name.endsWith('.zstd') ? 'zstd' : 'raw';
    const version = parseSessionFormatLogFilename(compression === 'zstd' ? name.slice(0, -'.zstd'.length) : name);
    if (version === undefined)
        return undefined;
    return { version, compression, name };
}
/**
 * Select one highest-generation persistence path per physical Session directory.
 *
 * @param paths - Relative or absolute paths beneath a sessions root.
 * @param compression - Compression selected by the snapshot composition.
 * @returns Stable path order with older generations and filesystem noise omitted.
 */
export function latestPersistedSessionPaths(paths, compression = 'raw') {
    const selected = new Map();
    for (const path of paths) {
        const parsed = parsePersistedSessionFilename(basename(path));
        if (parsed === undefined || parsed.compression !== compression)
            continue;
        const directory = dirname(path);
        const previous = selected.get(directory);
        if (previous === undefined || parsed.version > previous.version) {
            selected.set(directory, { path, version: parsed.version });
        }
    }
    return [...selected.values()].map(entry => entry.path).sort();
}
/**
 * Require one persistence basename's generation to equal its Session header.
 *
 * @param name - Canonical persistence basename.
 * @param content - Complete uncompressed UTF-8 JSONL content.
 * @returns The validated generation.
 */
export function assertPersistedSessionVersion(name, content) {
    const persisted = parsePersistedSessionFilename(name);
    if (persisted === undefined)
        throw new Error(`not a canonical Session persistence filename: ${name}`);
    const headerVersion = sessionHeaderVersion(content, name);
    if (headerVersion !== persisted.version) {
        throw new Error(`${name}: filename declares Session format v${persisted.version}, header declares v${headerVersion}`);
    }
    return headerVersion;
}
//# sourceMappingURL=session-files.js.map