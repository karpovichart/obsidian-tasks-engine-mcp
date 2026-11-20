/** Write one Obsidian Tasks checkbox to an existing Markdown file in a vault. */
import { appendFileSync, realpathSync, readFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { extname, isAbsolute, resolve } from 'node:path';

import { findMarkdownFiles, readVault } from './vault';
import { isInside, vaultRelative } from './paths';

export interface AddTaskOptions {
    /** Existing vault-relative Markdown file; omitted means newest-created Markdown file. */
    targetFile?: string;
    /** Optional scheduled date in YYYY-MM-DD format. */
    scheduledDate?: string;
    /** Optional due date in YYYY-MM-DD format. */
    dueDate?: string;
    /** Caller-chosen ID; checked for uniqueness across the readable vault. */
    id?: string;
    /** Generate a random ID and check it for uniqueness across the readable vault. */
    generateId?: boolean;
}

export interface AddTaskResult {
    file: string;
    line: string;
}

/** Append a task without allowing the target path to leave the configured vault/scope. */
export function addTask(
    root: string,
    scope: string | undefined,
    description: string,
    options: AddTaskOptions = {},
): AddTaskResult {
    const text = description.trim();
    if (text.length === 0) throw new Error('Task description must not be empty.');
    if (/[\r\n\0]/.test(text)) throw new Error('Task description must fit on one line.');
    if (/^-\s+\[[^\]]\]\s/.test(text)) {
        throw new Error('Pass the task description without a Markdown checkbox prefix.');
    }
    validateDate(options.scheduledDate, 'scheduledDate');
    validateDate(options.dueDate, 'dueDate');
    if (options.id !== undefined && options.generateId) throw new Error('Choose either a custom id or generateId, not both.');
    if (options.id !== undefined) validateTaskId(options.id);

    let id: string | undefined;
    if (options.id !== undefined || options.generateId) {
        const index = readVault([root]);
        if (index.problems.length > 0) {
            throw new Error('Cannot safely verify task ID uniqueness because some vault files could not be read: ' + index.problems.slice(0, 5).join('; '));
        }
        const used = new Set(index.tasks.map((task) => task.id).filter(Boolean));
        if (options.id !== undefined) {
            if (used.has(options.id)) throw new Error(`Task ID '${options.id}' is already used in this vault.`);
            id = options.id;
        } else {
            for (let attempt = 0; attempt < 8; attempt++) {
                const candidate = randomBytes(3).toString('hex');
                if (!used.has(candidate)) { id = candidate; break; }
            }
            if (!id) throw new Error('Could not generate a unique task ID; try again.');
        }
    }

    const vaultRoot = realpathSync(root);
    const scopeRoot = scope ? resolve(vaultRoot, scope) : vaultRoot;
    if (!isInside(scopeRoot, vaultRoot)) throw new Error('Configured scope leads outside the vault.');
    const realScope = realpathSync(scopeRoot);
    if (!isInside(realScope, vaultRoot)) throw new Error('Configured scope leads outside the vault.');

    const filePath = options.targetFile
        ? resolveTargetFile(vaultRoot, realScope, options.targetFile)
        : newestCreatedMarkdown(realScope, vaultRoot);
    const relativeFile = vaultRelative(filePath, vaultRoot);
    const line = `- [ ] ${text}` +
        (options.scheduledDate ? ` ⏳ ${options.scheduledDate}` : '') +
        (options.dueDate ? ` 📅 ${options.dueDate}` : '') +
        (id ? ` 🆔 ${id}` : '');

    const contents = readFileSync(filePath, 'utf8');
    const separator = contents.length > 0 && !contents.endsWith('\n') ? '\n' : '';
    appendFileSync(filePath, `${separator}${line}\n`, 'utf8');
    return { file: relativeFile, line };
}

function validateTaskId(id: string): void {
    if (id.length === 0 || id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id)) {
        throw new Error('Task IDs must be 1–64 letters, digits, underscores, or hyphens.');
    }
}

export function resolveTargetFile(vaultRoot: string, scopeRoot: string, targetFile: string): string {
    if (targetFile.trim() !== targetFile || targetFile.length === 0 || isAbsolute(targetFile)) {
        throw new Error('targetFile must be a non-empty path relative to the vault.');
    }
    const segments = targetFile.split(/[\\/]/);
    if (segments.some((part) => part === '..' || part === '.' || part.startsWith('.'))) {
        throw new Error('targetFile may not contain parent, current, or hidden path segments.');
    }
    if (extname(targetFile).toLowerCase() !== '.md') throw new Error('targetFile must be a Markdown (.md) file.');

    const candidate = resolve(vaultRoot, targetFile);
    if (!isInside(candidate, scopeRoot)) throw new Error('targetFile must be inside the configured vault scope.');
    const realFile = realpathSync(candidate);
    if (!isInside(realFile, scopeRoot)) throw new Error('targetFile resolves outside the configured vault scope.');
    if (!statSync(realFile).isFile()) throw new Error('targetFile must name an existing file.');
    return realFile;
}

function newestCreatedMarkdown(scopeRoot: string, vaultRoot: string): string {
    const { files } = findMarkdownFiles(scopeRoot, vaultRoot);
    const candidates = files
        .map((file) => {
            const stats = statSync(file);
            // birthtime is creation time where available; ctime is the portable fallback.
            const created = stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.ctimeMs;
            return { file, created };
        })
        .sort((left, right) => right.created - left.created || left.file.localeCompare(right.file));
    if (candidates.length === 0) {
        throw new Error('No existing Markdown files found in the configured vault scope. Specify targetFile or create a note first.');
    }
    const newest = realpathSync(candidates[0].file);
    if (!isInside(newest, scopeRoot)) throw new Error('Newest Markdown file resolves outside the configured vault scope.');
    return newest;
}

export function validateDate(value: string | undefined, name: string): void {
    if (value === undefined) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} must use YYYY-MM-DD format.`);
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        throw new Error(`${name} must be a real calendar date.`);
    }
}
