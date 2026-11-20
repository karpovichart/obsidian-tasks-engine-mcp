/** Create a fixed sync marker; callers cannot choose a file path. */
import { writeFileSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';

export function requestSync(): boolean {
    const markerPath = process.env.OBSIDIAN_TASKS_MCP_SYNC_MARKER_PATH;
    if (!markerPath || !isAbsolute(markerPath) || basename(markerPath) !== '.sync') {
        throw new Error('OBSIDIAN_TASKS_MCP_SYNC_MARKER_PATH must be an absolute path ending in .sync.');
    }

    try {
        writeFileSync(markerPath, '', { flag: 'wx', mode: 0o600 });
        return true;
    } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
            return false;
        }
        throw error;
    }
}
