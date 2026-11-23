import { create } from "zustand";
import type { LaunchReplay } from "../components/TaskComposer";

export const DEFAULT_UNLOCK_TIMES = ["11:00", "16:00", "20:00"];
const STORAGE_KEY = "ao.deepWork.v1";
const WALL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export type PlanningJournal = {
	title: string;
	notes: string;
	questions: string[];
};

export type DeepWorkTask = PlanningJournal & {
	id: string;
	projectId: string;
	hostId?: string;
	stage: "journal" | "chat";
	planningSessionId?: string;
	/** The worker prompt drafted in the Hand off dialog. Empty until the user types. */
	handoff?: string;
	/** Launch request for the worker, kept so a lost response can be retried idempotently. */
	buildRequest?: { requestId: string; replay: LaunchReplay; text: string };
	pending?: { kind: "start"; requestId: string; replay: LaunchReplay; text: string; journal: PlanningJournal };
};

type DeepWorkState = {
	enabled: boolean;
	side: "deep" | "shallow";
	times: string[];
	// An occurrence must be strictly later than the last activation or return.
	eligibleAfter: number;
	// Schedule changes preserve an unlock that had already come due.
	unlockOwed: boolean;
	task?: DeepWorkTask;
};

const defaults: DeepWorkState = {
	enabled: false,
	side: "deep",
	times: DEFAULT_UNLOCK_TIMES,
	eligibleAfter: 0,
	unlockOwed: false,
};

export function parseUnlockTimes(input: string): string[] | undefined {
	const times = input.split(/[\s,]+/).filter(Boolean);
	return times.every((time) => WALL_TIME.test(time)) ? [...new Set(times)].sort() : undefined;
}

/** Recompute from calendar dates on wake. Several due occurrences buy one visit. */
export function shallowUnlock(state: Pick<DeepWorkState, "times" | "eligibleAfter" | "unlockOwed">, now = new Date()) {
	let due = state.unlockOwed;
	let next: Date | undefined;
	// Yesterday covers long sleeps, while tomorrow covers having used today's
	// final unlock. Date's local constructor uses one occurrence on a repeated
	// hour and moves a skipped hour forward by the DST gap.
	for (const offset of [-1, 0, 1]) {
		for (const time of state.times) {
			const [hour, minute] = time.split(":").map(Number);
			const occurrence = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hour, minute);
			if (occurrence.getTime() <= state.eligibleAfter) continue;
			if (occurrence <= now) due = true;
			else if (!next || occurrence < next) next = occurrence;
		}
	}
	return { due, next };
}

type PersistedTask = Partial<Omit<DeepWorkTask, "stage">> & {
	stage?: string;
	// Fields from earlier prototypes that no longer exist. They are dropped on load.
	generation?: unknown;
	delivered?: unknown;
	workerSessionId?: unknown;
};

/**
 * Loads a task saved by any earlier shape. Planning Chat is one-way, so any task
 * with a planner session resumes there. A "handoff" stage and a worker session
 * are now just a draft in the Chat, and an accepted worker is retried by its
 * saved request.
 */
function restoreTask(saved: PersistedTask | undefined): DeepWorkTask | undefined {
	if (!saved) return undefined;
	// A worker was already accepted for this task, so the task was handed off.
	// Only the old planner cleanup was holding it, and that cleanup is gone.
	if (saved.workerSessionId) return undefined;
	if (saved.stage !== "journal" && saved.stage !== "chat" && saved.stage !== "handoff") {
		// The first local prototype held a separate manual handoff. Restore its
		// journal, without replaying a request for that superseded workflow.
		return {
			id: saved.id ?? "", projectId: saved.projectId ?? "", hostId: saved.hostId,
			stage: "journal", title: saved.title ?? "", notes: saved.notes ?? "", questions: saved.questions ?? [],
		};
	}
	return {
		id: saved.id ?? "",
		projectId: saved.projectId ?? "",
		hostId: saved.hostId,
		title: saved.title ?? "",
		notes: saved.notes ?? "",
		questions: saved.questions ?? [],
		stage: saved.planningSessionId ? "chat" : "journal",
		planningSessionId: saved.planningSessionId,
		handoff: saved.handoff,
		buildRequest: saved.buildRequest,
		pending: saved.pending?.kind === "start" ? saved.pending : undefined,
	};
}

function readState(): DeepWorkState {
	try {
		const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as (Omit<DeepWorkState, "task"> & { task?: PersistedTask }) | null;
		if (saved && Array.isArray(saved.times) && saved.times.every((time) => WALL_TIME.test(time))) {
			return { ...defaults, ...saved, task: restoreTask(saved.task) };
		}
	} catch {
		// A profile without saved state starts in normal mode.
	}
	return defaults;
}

type DeepWorkStore = DeepWorkState & {
	storageError?: string;
	setEnabled: (enabled: boolean, now?: number) => boolean;
	setTimes: (times: string[], now?: number) => boolean;
	switchSide: (now?: number) => boolean;
	beginTask: (projectId: string, hostId?: string) => boolean;
	updateTask: (id: string, fields: Partial<Omit<DeepWorkTask, "id">>) => boolean;
	clearTask: (id: string) => boolean;
};

export const useDeepWorkStore = create<DeepWorkStore>((set, get) => {
	const update = (changes: Partial<DeepWorkState>) => {
		const { enabled, side, times, eligibleAfter, unlockOwed, task } = get();
		const next = { enabled, side, times, eligibleAfter, unlockOwed, task, ...changes };
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
		} catch {
			set({ storageError: "Deep Work changes could not be saved on this desktop." });
			return false;
		}
		set({ ...next, storageError: undefined });
		return true;
	};

	return {
		...readState(),
		setEnabled: (enabled, now = Date.now()) => {
			if (get().task || enabled === get().enabled) return false;
			return update({ enabled, side: "deep", eligibleAfter: now, unlockOwed: false });
		},
		setTimes: (times, now = Date.now()) => {
			const state = get();
			const unlockOwed = state.enabled && state.side === "deep" && shallowUnlock(state, new Date(now)).due;
			return update({ times, unlockOwed, eligibleAfter: now });
		},
		switchSide: (now = Date.now()) => {
			const state = get();
			if (!state.enabled || state.task) return false;
			if (state.side === "shallow") return update({ side: "deep", eligibleAfter: now, unlockOwed: false });
			if (!shallowUnlock(state, new Date(now)).due) return false;
			return update({ side: "shallow", eligibleAfter: now, unlockOwed: false });
		},
		beginTask: (projectId, hostId) => {
			const state = get();
			if (!state.enabled || state.side !== "deep" || state.task) return false;
			return update({ task: { id: crypto.randomUUID(), projectId, hostId, stage: "journal", title: "", notes: "", questions: [] } });
		},
		updateTask: (id, fields) => {
			const task = get().task;
			return task?.id === id && update({ task: { ...task, ...fields } });
		},
		clearTask: (id) => get().task?.id === id && update({ task: undefined }),
	};
});

export function shallowWorkHidden(state: Pick<DeepWorkState, "enabled" | "side">) {
	return state.enabled && state.side === "deep";
}

export function deepWorkRouteBlocked(pathname: string, state: Pick<DeepWorkState, "enabled" | "side">) {
	if (!state.enabled) return false;
	const path = pathname.toLowerCase().replace(/\/+$/, "") || "/";
	if (state.side === "shallow") return path === "/new";
	return path !== "/" && path !== "/settings";
}
