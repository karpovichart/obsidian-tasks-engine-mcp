/** Update one existing Obsidian Tasks item by its exact line and expected content. */
import { randomBytes } from 'node:crypto';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { StatusRegistry } from '../vendor/obsidian-tasks/src/Statuses/StatusRegistry';
import { StatusType } from '../vendor/obsidian-tasks/src/Statuses/StatusConfiguration';
import { Task } from '../vendor/obsidian-tasks/src/Task/Task';
import { TaskLocation } from '../vendor/obsidian-tasks/src/Task/TaskLocation';
import { TasksFile } from '../vendor/obsidian-tasks/src/Scripting/TasksFile';

import { applyVaultSettings } from './settings';
import { withEngineLock } from './engine';
import { resolveTargetFile, validateDate } from './task-writer';
import { isInside, vaultRelative } from './paths';
import { readVault } from './vault';

export type EditableTaskStatus = 'todo' | 'in_progress' | 'on_hold' | 'done' | 'cancelled';

export interface UpdateTaskOptions {
    file: string;
    lineNumber: number;
    expectedMarkdown: string;
    description?: string;
    status?: EditableTaskStatus;
    scheduledDate?: string | null;
    dueDate?: string | null;
    /** Set a caller-chosen unique ID, or null to remove this task's ID. */
    id?: string | null;
    /** Generate a random ID and verify it is not already used in the vault. */
    generateId?: boolean;
    /** Replace dependencies with these existing task IDs; [] clears dependencies. */
    dependsOn?: string[];
}

export interface UpdateTaskResult {
    file: string;
    oldLine: string;
    newLines: string[];
}

/** Update one line and preserve the file's other text and line endings. */
export function updateTask(root: string, scope: string | undefined, options: UpdateTaskOptions): Promise<UpdateTaskResult> {
    return withEngineLock(async () => {
        applyVaultSettings([root], { scope });
        validateDate(options.scheduledDate ?? undefined, 'scheduledDate');
        validateDate(options.dueDate ?? undefined, 'dueDate');
        if (!Number.isInteger(options.lineNumber) || options.lineNumber < 0) {
            throw new Error('lineNumber must be a non-negative, zero-based line number from query details.');
        }
        if (/[\r\n\0]/.test(options.expectedMarkdown)) {
            throw new Error('expectedMarkdown must contain exactly one line.');
        }
        if (options.generateId && options.id !== undefined) {
            throw new Error('Choose either a custom id or generateId, not both.');
        }
        if (options.id !== undefined && options.id !== null) validateTaskId(options.id);
        if (options.dependsOn !== undefined) {
            const unique = new Set(options.dependsOn);
            if (unique.size !== options.dependsOn.length) throw new Error('dependsOn must not contain duplicate IDs.');
            options.dependsOn.forEach(validateTaskId);
        }
        if (options.description !== undefined) {
            const description = options.description.trim();
            if (!description) throw new Error('description must not be empty.');
            if (/[\r\n\0]/.test(description)) throw new Error('description must fit on one line.');
            if (/^-\s+\[[^\]]\]\s/.test(description)) {
                throw new Error('Pass the replacement description without a Markdown checkbox prefix.');
            }
        }

        const vaultRoot = realpathSync(root);
        const scopeCandidate = scope ? resolve(vaultRoot, scope) : vaultRoot;
        if (!isInside(scopeCandidate, vaultRoot)) throw new Error('Configured scope leads outside the vault.');
        const scopeRoot = realpathSync(scopeCandidate);
        if (!isInside(scopeRoot, vaultRoot)) throw new Error('Configured scope leads outside the vault.');
        const filePath = resolveTargetFile(vaultRoot, scopeRoot, options.file);
        const relativeFile = vaultRelative(filePath, vaultRoot);
        const before = statSync(filePath);
        const contents = readFileSync(filePath, 'utf8');
        const afterRead = statSync(filePath);
        if (!sameFileVersion(before, afterRead)) throw new Error('The note changed while it was being read; query it again and retry.');

        const chunks = contents.match(/[^\n]*\n|[^\n]+$/g) ?? [];
        const index = options.lineNumber;
        if (index >= chunks.length) throw new Error(`No line index ${options.lineNumber} exists in ${relativeFile}.`);
        const oldChunk = chunks[index];
        const oldLine = oldChunk.replace(/\r?\n$/, '');
        if (oldLine !== options.expectedMarkdown) {
            throw new Error('The task line no longer matches expectedMarkdown; query the note again before editing.');
        }

        const task = Task.parseTaskSignifiers(
            oldLine,
            TaskLocation.fromUnknownPosition(new TasksFile(relativeFile)),
            null,
        );
        if (task === null) throw new Error('The selected line is not a valid Obsidian Tasks item.');

        const metadataUpdateRequested = options.id !== undefined || options.generateId === true || options.dependsOn !== undefined;
        const allTasks = metadataUpdateRequested ? readTasksForMetadata(root) : [];
        const taskIdentity = { path: relativeFile, lineNumber: options.lineNumber };
        const matchingVaultTask = allTasks.find((item) => item.path === taskIdentity.path && item.lineNumber === taskIdentity.lineNumber);
        if (metadataUpdateRequested && !matchingVaultTask) {
            throw new Error('The selected task is not present in the readable Tasks index; query the vault again.');
        }

        let resultingId: string | undefined;
        if (options.generateId) {
            resultingId = generateUniqueId(allTasks);
        } else if (options.id !== undefined) {
            resultingId = options.id ?? '';
        }
        const effectiveId = resultingId === undefined ? task.id : resultingId;
        const effectiveDependencies = options.dependsOn ?? task.dependsOn;
        if (metadataUpdateRequested) {
            validateIdChange(allTasks, taskIdentity, task.id, effectiveId);
            if (options.dependsOn !== undefined) {
                validateDependencies(allTasks, taskIdentity, effectiveId, effectiveDependencies);
            }
        }

        const scheduledDate = options.scheduledDate === undefined
            ? undefined
            : options.scheduledDate === null
              ? null
              : window.moment(options.scheduledDate, 'YYYY-MM-DD');
        const dueDate = options.dueDate === undefined
            ? undefined
            : options.dueDate === null
              ? null
              : window.moment(options.dueDate, 'YYYY-MM-DD');
        let updated = new Task({
            ...task,
            ...(options.description === undefined ? {} : { description: options.description.trim() }),
            ...(options.scheduledDate === undefined ? {} : { scheduledDate, scheduledDateIsInferred: false }),
            ...(options.dueDate === undefined ? {} : { dueDate }),
            ...(resultingId === undefined ? {} : { id: resultingId }),
            ...(options.dependsOn === undefined ? {} : { dependsOn: options.dependsOn }),
        });

        let newTasks = [updated];
        if (options.status !== undefined) {
            const type = statusType(options.status);
            const newStatus = StatusRegistry.getInstance().registeredStatuses.find((entry) => entry.type === type);
            if (!newStatus) throw new Error(`The vault has no configured status for '${options.status}'.`);
            newTasks = updated.handleNewStatusWithRecurrenceInUsersOrder(newStatus);
        }
        const newLines = newTasks.map((item) => item.toFileLineString());
        const ending = /\r?\n$/.exec(oldChunk)?.[0] ?? '';
        const newline = ending || (contents.includes('\r\n') ? '\r\n' : '\n');
        chunks[index] = newLines
            .map((line, lineIndex) => line + (lineIndex < newLines.length - 1 ? newline : ending))
            .join('');

        const beforeWrite = statSync(filePath);
        if (!sameFileVersion(afterRead, beforeWrite)) throw new Error('The note changed before the update could be saved; query it again and retry.');
        writeFileSync(filePath, chunks.join(''), 'utf8');
        return { file: relativeFile, oldLine, newLines };
    });
}



function readTasksForMetadata(root: string): Task[] {
    const result = readVault([root]);
    if (result.problems.length > 0) {
        throw new Error('Cannot safely verify task IDs and dependencies because some vault files could not be read: ' + result.problems.slice(0, 5).join('; '));
    }
    return result.tasks;
}

function validateTaskId(id: string): void {
    if (id.length === 0 || id.length > 64 || !/^[A-Za-z0-9_-]+$/.test(id)) {
        throw new Error('Task IDs must be 1–64 letters, digits, underscores, or hyphens.');
    }
}

function generateUniqueId(tasks: Task[]): string {
    const used = new Set(tasks.map((task) => task.id).filter(Boolean));
    for (let attempt = 0; attempt < 8; attempt++) {
        const id = randomBytes(3).toString('hex');
        if (!used.has(id)) return id;
    }
    throw new Error('Could not generate a unique task ID; try again.');
}

function validateIdChange(
    tasks: Task[],
    target: { path: string; lineNumber: number },
    oldId: string,
    newId: string,
): void {
    const others = tasks.filter((task) => task.path !== target.path || task.lineNumber !== target.lineNumber);
    if (newId && others.some((task) => task.id === newId)) {
        throw new Error(`Task ID '${newId}' is already used in this vault.`);
    }
    if (oldId && oldId !== newId) {
        const dependents = others.filter((task) => task.dependsOn.includes(oldId));
        if (dependents.length > 0) {
            throw new Error(`Task ID '${oldId}' is used by ${dependents.length} dependent task(s); update those dependencies before changing or removing this ID.`);
        }
    }
}

function validateDependencies(
    tasks: Task[],
    target: { path: string; lineNumber: number },
    targetId: string,
    dependencies: string[],
): void {
    const ids = new Map<string, Task[]>();
    for (const task of tasks) {
        if (!task.id) continue;
        const matches = ids.get(task.id) ?? [];
        matches.push(task);
        ids.set(task.id, matches);
    }
    const duplicateIds = [...ids.entries()].filter(([, matches]) => matches.length > 1).map(([id]) => id);
    if (duplicateIds.length > 0) throw new Error(`Resolve duplicate task IDs before changing dependencies: ${duplicateIds.join(', ')}.`);

    for (const id of dependencies) {
        const matches = ids.get(id) ?? [];
        if (matches.length === 0) throw new Error(`Dependency ID '${id}' does not belong to a task in this vault.`);
        if (matches.length > 1) throw new Error(`Dependency ID '${id}' is ambiguous because it is duplicated in this vault.`);
        if (matches[0].path === target.path && matches[0].lineNumber === target.lineNumber) {
            throw new Error('A task cannot depend on itself.');
        }
    }

    if (!targetId) return;
    const graph = new Map<string, string[]>();
    for (const task of tasks) {
        if (!task.id || (task.path === target.path && task.lineNumber === target.lineNumber)) continue;
        if (graph.has(task.id)) throw new Error(`Task ID '${task.id}' is duplicated; resolve duplicates before changing dependencies.`);
        graph.set(task.id, task.dependsOn);
    }
    graph.set(targetId, dependencies);
    for (const id of dependencies) {
        if (reachesId(graph, id, targetId, new Set())) throw new Error(`This dependency would create a cycle involving task ID '${targetId}'.`);
    }
}

function reachesId(graph: Map<string, string[]>, current: string, goal: string, visited: Set<string>): boolean {
    if (current === goal) return true;
    if (visited.has(current)) return false;
    visited.add(current);
    return (graph.get(current) ?? []).some((dependency) => reachesId(graph, dependency, goal, visited));
}

function statusType(status: EditableTaskStatus): StatusType {
    switch (status) {
        case 'todo': return StatusType.TODO;
        case 'in_progress': return StatusType.IN_PROGRESS;
        case 'on_hold': return StatusType.ON_HOLD;
        case 'done': return StatusType.DONE;
        case 'cancelled': return StatusType.CANCELLED;
    }
}

function sameFileVersion(left: ReturnType<typeof statSync>, right: ReturnType<typeof statSync>): boolean {
    return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ino === right.ino;
}
