// Task rules shared by the REST API (worker/api.ts) and the MCP tools (worker/mcp.ts).
// Every check about who may see or change a task lives here, so the two can't drift apart.
import { isDate } from '../shared/dates';
import { NOTES_MAX, TITLE_MAX, type Priority, type Task } from '../shared/types';
import {
  type Env, type EventRow, type TaskRow, type Viewer,
  CURRENT_VERSION, TASK_COLS, bad, bumpVersion, canSeeProject, eventStmt, forbidden, mapTask, notFound, nowIso, today, uid,
  userOnProject,
} from './lib';

/** SQL fragment limiting tasks to the projects the viewer can see. */
export const visible = (v: Viewer, alias = '') =>
  v.role === 'admin'
    ? { sql: '1 = 1', binds: [] as unknown[] }
    : { sql: `${alias}project_id IN (SELECT project_id FROM project_members WHERE user_id = ?)`, binds: [v.id] as unknown[] };

export async function loadTask(db: D1Database, id: string) {
  return db.prepare(`SELECT ${TASK_COLS} FROM tasks WHERE id = ?`).bind(id).first<TaskRow>();
}

/** A task the viewer can see, or 404 (never 403: hidden tasks don't exist for them). */
export async function loadVisibleTask(db: D1Database, v: Viewer, id: string) {
  const t = await loadTask(db, id);
  if (!t || !canSeeProject(v, t.project_id)) throw notFound('Task not found.');
  return t;
}

const isPriority = (p: unknown): p is Priority => p === 1 || p === 2 || p === 3 || p === 4;

// ---------- create ----------
export interface NewTask {
  title: string;
  notes?: string;
  projectId: string;
  assigneeId: string;
  dueDate: string;
  priority: number;
}

/**
 * Validates and inserts a task as `v`. `via` names the AI assistant that made it (null from the app).
 * Callers fill in their own defaults first: the app defaults to "me, today, Normal"; MCP requires all of them.
 */
export async function createTask(env: Env, v: Viewer, b: NewTask, via: string | null = null): Promise<Task> {
  const db = env.DB;
  const title = (b.title ?? '').trim();
  const notes = (b.notes ?? '').trim();
  const t0 = today(env);
  if (!title) throw bad('A task needs a title.');
  if (title.length > TITLE_MAX) throw bad(`Titles can be at most ${TITLE_MAX} characters.`);
  if (notes.length > NOTES_MAX) throw bad('Notes are too long.');
  if (!b.projectId || !canSeeProject(v, b.projectId)) throw bad('Pick one of your projects.');
  const project = await db.prepare('SELECT id FROM projects WHERE id = ? AND archived = 0').bind(b.projectId).first();
  if (!project) throw bad('That project no longer exists.');
  if (!b.assigneeId || !(await userOnProject(db, b.assigneeId, b.projectId))) throw bad("That person isn't on this project.");
  if (!isDate(b.dueDate)) throw bad('Invalid date.');
  if (b.dueDate < t0) throw bad("Tasks can't be due in the past.");
  if (!isPriority(b.priority)) throw bad('Invalid priority.');

  const id = uid();
  const now = nowIso();
  await db.batch([
    bumpVersion(db),
    db.prepare(
      `INSERT INTO tasks (id, title, notes, project_id, assignee_id, created_by, assigned_by, due_date, priority, status, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ${CURRENT_VERSION})`,
    ).bind(id, title, notes, b.projectId, b.assigneeId, v.id, v.id, b.dueDate, b.priority, now, now),
    eventStmt(db, {
      taskId: id, actorId: v.id, via, type: 'created', at: now,
      to: JSON.stringify({ assignee: b.assigneeId, due: b.dueDate, priority: b.priority, project: b.projectId }),
    }),
  ]);
  return mapTask((await loadTask(db, id))!);
}

// ---------- edit (every change is logged) ----------
export interface Patch {
  title?: string; notes?: string; projectId?: string; assigneeId?: string; dueDate?: string; priority?: number;
  status?: 'open' | 'done';
  /** Optional message attached to a transfer. */
  note?: string;
  /** Undo of your own last date move: allows putting a past due date back. */
  restore?: boolean;
}

/**
 * Validates a change and returns the statements that make it (task update + one history event per field).
 * Nothing is written; run the statements with `commit()` (or batch several patches together).
 */
export async function applyPatch(env: Env, v: Viewer, id: string, b: Patch, via: string | null = null) {
  const db = env.DB;
  const t = await loadVisibleTask(db, v, id);
  const t0 = today(env);
  const now = nowIso();
  const sets: string[] = [];
  const binds: unknown[] = [];
  const events: Parameters<typeof eventStmt>[1][] = [];
  const set = (col: string, val: unknown) => { sets.push(`${col} = ?`); binds.push(val); };
  const ev = (e: Omit<Parameters<typeof eventStmt>[1], 'taskId' | 'actorId' | 'via' | 'at'>) =>
    events.push({ ...e, taskId: id, actorId: v.id, via, at: now });

  if (b.title !== undefined) {
    const title = b.title.trim();
    if (!title) throw bad('A task needs a title.');
    if (title.length > TITLE_MAX) throw bad(`Titles can be at most ${TITLE_MAX} characters.`);
    if (title !== t.title) { set('title', title); ev({ type: 'renamed', from: t.title, to: title }); }
  }
  if (b.notes !== undefined) {
    const notes = b.notes.trim();
    if (notes.length > NOTES_MAX) throw bad('Notes are too long.');
    if (notes !== t.notes) { set('notes', notes); ev({ type: 'notes_edited' }); }
  }
  if (b.priority !== undefined && b.priority !== t.priority) {
    if (!isPriority(b.priority)) throw bad('Invalid priority.');
    set('priority', b.priority);
    ev({ type: 'priority_changed', from: String(t.priority), to: String(b.priority) });
  }
  const project = b.projectId ?? t.project_id;
  const assignee = b.assigneeId ?? t.assignee_id;
  if (project !== t.project_id) {
    if (!canSeeProject(v, project)) throw forbidden("You're not on that project.");
    const p = await db.prepare('SELECT id FROM projects WHERE id = ? AND archived = 0').bind(project).first();
    if (!p) throw bad('That project no longer exists.');
    set('project_id', project);
    ev({ type: 'project_changed', from: t.project_id, to: project });
  }
  if (project !== t.project_id || assignee !== t.assignee_id) {
    // The assignee must always be able to see the task.
    if (!(await userOnProject(db, assignee, project))) throw bad("That person isn't on this task's project.");
  }
  if (assignee !== t.assignee_id) {
    set('assignee_id', assignee);
    set('assigned_by', v.id);
    const note = (b.note ?? '').trim().slice(0, 500) || null;
    ev({ type: 'transferred', from: t.assignee_id, to: assignee, note });
  }
  if (b.dueDate !== undefined && b.dueDate !== t.due_date) {
    if (!isDate(b.dueDate)) throw bad('Invalid date.');
    if (b.dueDate < t0) {
      const last = await db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY at DESC LIMIT 1').bind(id).first<EventRow>();
      const isUndo = b.restore && last?.type === 'date_moved' && last.actor_id === v.id && last.from_value === b.dueDate;
      if (!isUndo) throw bad("Tasks can't be moved into the past.");
    }
    set('due_date', b.dueDate);
    ev({ type: 'date_moved', from: t.due_date, to: b.dueDate });
  }
  if (b.status !== undefined && b.status !== t.status) {
    if (b.status === 'done') {
      set('status', 'done'); set('done_at', now); set('done_on', t0); set('done_by', v.id);
      ev({ type: 'done' });
    } else if (b.status === 'open') {
      set('status', 'open'); set('done_at', null); set('done_on', null); set('done_by', null);
      ev({ type: 'reopened' });
    } else throw bad('Invalid status.');
  }
  if (!events.length) return { stmts: [] as D1PreparedStatement[], changed: false };
  const stmts = [
    db.prepare(`UPDATE tasks SET ${sets.join(', ')}, updated_at = ?, version = ${CURRENT_VERSION} WHERE id = ?`).bind(...binds, now, id),
    ...events.map((e) => eventStmt(db, e)),
  ];
  return { stmts, changed: true };
}

/** Writes the statements from one or more patches in a single batch (one version bump). */
export async function commit(env: Env, stmts: D1PreparedStatement[]) {
  if (stmts.length) await env.DB.batch([bumpVersion(env.DB), ...stmts]);
}

/** Validate, write and return the updated task. */
export async function updateTask(env: Env, v: Viewer, id: string, b: Patch, via: string | null = null): Promise<Task> {
  const { stmts } = await applyPatch(env, v, id, b, via);
  await commit(env, stmts);
  return mapTask((await loadTask(env.DB, id))!);
}
