import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_UNLOCK_TIMES } from "./deep-work-store";

const local = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute);

beforeEach(() => {
	localStorage.clear();
	vi.resetModules();
});

describe("Deep Work schedule and focus", () => {
	it("starts off, ignores older times, holds one missed unlock and relocks on return", async () => {
		const { useDeepWorkStore, shallowUnlock } = await import("./deep-work-store");
		const current = useDeepWorkStore.getState;
		expect(current().enabled).toBe(false);
		expect(current().times).toEqual(DEFAULT_UNLOCK_TIMES);
		current().setEnabled(true, +local(20, 12));
		expect(shallowUnlock(current(), local(20, 15, 59))).toEqual({ due: false, next: local(20, 16) });
		expect(shallowUnlock(current(), local(20, 16)).due).toBe(true);
		// Several missed times, followed by another one while Shallow is open.
		expect(current().switchSide(+local(21, 15))).toBe(true);
		expect(current().side).toBe("shallow");
		expect(current().switchSide(+local(21, 17))).toBe(true);
		expect(current().side).toBe("deep");
		expect(shallowUnlock(current(), local(21, 17))).toEqual({ due: false, next: local(21, 20) });
		expect(current().switchSide(+local(21, 17))).toBe(false);
	});

	it("retains a due pass when editing an unlimited daily schedule", async () => {
		const { useDeepWorkStore, shallowUnlock, parseUnlockTimes } = await import("./deep-work-store");
		const current = useDeepWorkStore.getState;
		const times = Array.from({ length: 60 }, (_, minute) => `09:${String(minute).padStart(2, "0")}`);
		expect(parseUnlockTimes(`${times.join(", ")}\n09:01`)).toEqual(times);
		expect(parseUnlockTimes("11:00, 24:00")).toBeUndefined();
		current().setEnabled(true, +local(21, 10));
		current().setTimes(times, +local(21, 12));
		expect(shallowUnlock(current(), local(21, 12))).toEqual({ due: true, next: local(22, 9) });
		expect(current().switchSide(+local(21, 12))).toBe(true);
		current().switchSide(+local(21, 12, 1));
		expect(shallowUnlock(current(), local(21, 12, 1)).due).toBe(false);
	});

	it("restores the same exclusive task, schedule and handoff draft after a restart", async () => {
		const { useDeepWorkStore } = await import("./deep-work-store");
		const current = useDeepWorkStore.getState;
		current().setEnabled(true, +local(21, 10));
		current().setTimes(["13:00", "21:00"], +local(21, 10));
		expect(current().beginTask("project", "remote")).toBe(true);
		const id = current().task!.id;
		current().updateTask(id, {
			stage: "chat", planningSessionId: "planner", title: "Journal", notes: "Ideas", questions: ["Which one?"], handoff: "Build plan A",
			buildRequest: { requestId: "retry", text: "Build plan A", replay: { agent: "codex", mode: "chat" } },
		});
		vi.resetModules();
		const restored = (await import("./deep-work-store")).useDeepWorkStore.getState;
		expect(restored().task).toEqual(current().task);
		expect(restored().times).toEqual(["13:00", "21:00"]);
		expect(restored().beginTask("other")).toBe(false);
		expect(restored().setEnabled(false)).toBe(false);
		expect(restored().switchSide(+local(22, 15))).toBe(false);
		expect(restored().clearTask(id)).toBe(true);
		expect(restored().switchSide(+local(22, 15))).toBe(true);
		vi.resetModules();
		const shallow = (await import("./deep-work-store")).useDeepWorkStore.getState;
		expect(shallow().side).toBe("shallow");
		expect(shallow().beginTask("other")).toBe(false);
		shallow().switchSide(+local(22, 15, 1));
		vi.resetModules();
		const { useDeepWorkStore: returned, shallowUnlock } = await import("./deep-work-store");
		expect(shallowUnlock(returned.getState(), local(22, 16)).due).toBe(false);
	});

	it("blocks shallow surfaces on Deep and the normal launcher on Shallow", async () => {
		const { deepWorkRouteBlocked } = await import("./deep-work-store");
		const deep = { enabled: true, side: "deep" as const };
		const shallow = { enabled: true, side: "shallow" as const };
		for (const path of ["/sessions", "/sessions/id", "/projects/project/sessions/id", "/host/remote/session/id", "/artifacts", "/usage", "/automations", "/new"]) {
			expect(deepWorkRouteBlocked(path, deep)).toBe(true);
			expect(deepWorkRouteBlocked(path, shallow)).toBe(path === "/new");
			expect(deepWorkRouteBlocked(path, { ...deep, enabled: false })).toBe(false);
		}
		expect(deepWorkRouteBlocked("/", deep)).toBe(false);
		expect(deepWorkRouteBlocked("/settings", deep)).toBe(false);
	});
	it("loads tasks saved before Planning Chat became one-way", async () => {
		const journal = { title: "T", notes: "N", questions: [] };
		localStorage.setItem("ao.deepWork.v1", JSON.stringify({
			enabled: true, side: "deep", times: ["11:00"], eligibleAfter: 0, unlockOwed: false,
			task: { id: "t", projectId: "p", stage: "handoff", planningSessionId: "planner", ...journal, handoff: "Old draft", generation: { requestId: "g" }, delivered: journal, pending: { kind: "update", requestId: "u", text: "x", journal } },
		}));
		const { useDeepWorkStore } = await import("./deep-work-store");
		const task = useDeepWorkStore.getState().task!;
		expect(task).toEqual({ id: "t", projectId: "p", stage: "chat", planningSessionId: "planner", ...journal, handoff: "Old draft" });
		expect(task).not.toHaveProperty("generation");
		expect(task).not.toHaveProperty("delivered");
	});

	it("releases a task whose worker had already started but was held by planner cleanup", async () => {
		localStorage.setItem("ao.deepWork.v1", JSON.stringify({
			enabled: true, side: "deep", times: ["11:00"], eligibleAfter: 0, unlockOwed: false,
			task: { id: "t", projectId: "p", stage: "handoff", planningSessionId: "planner", title: "", notes: "", questions: [], workerSessionId: "w" },
		}));
		const { useDeepWorkStore } = await import("./deep-work-store");
		expect(useDeepWorkStore.getState().task).toBeUndefined();
	});

	it("keeps a planner session in Planning Chat even when it was saved as the journal", async () => {
		localStorage.setItem("ao.deepWork.v1", JSON.stringify({
			enabled: true, side: "deep", times: ["11:00"], eligibleAfter: 0, unlockOwed: false,
			task: { id: "t", projectId: "p", stage: "journal", planningSessionId: "planner", title: "", notes: "", questions: [] },
		}));
		const { useDeepWorkStore } = await import("./deep-work-store");
		expect(useDeepWorkStore.getState().task?.stage).toBe("chat");
	});

	it("keeps a journal without a planner as the journal", async () => {
		localStorage.setItem("ao.deepWork.v1", JSON.stringify({
			enabled: true, side: "deep", times: ["11:00"], eligibleAfter: 0, unlockOwed: false,
			task: { id: "t", projectId: "p", stage: "handoff", title: "Idea", notes: "", questions: [] },
		}));
		const { useDeepWorkStore } = await import("./deep-work-store");
		expect(useDeepWorkStore.getState().task).toMatchObject({ stage: "journal", title: "Idea" });
	});
});
