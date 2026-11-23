import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDeepWorkStore } from "../stores/deep-work-store";
import { STANDALONE_WORKSPACE_ID } from "../types/workspace";
import { DeepWorkPage, DeepWorkSwitcher } from "./DeepWork";

const { useLaunch, launch, navigate, read, kill, remove } = vi.hoisted(() => ({
	useLaunch: vi.fn(), launch: vi.fn(), navigate: vi.fn(),
	read: vi.fn(), kill: vi.fn(), remove: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("./TaskComposer", () => ({ useTaskLaunch: useLaunch }));
vi.mock("../hooks/useWorkspaceQuery", () => ({
	workspaceQueryKeyForHost: () => ["workspaces"],
	useWorkspaceSession: (id: string) => ({ data: { id } }),
}));
vi.mock("../lib/host-clients", () => ({
	labelForHost: () => undefined,
	clientForSessionHost: () => ({ GET: read, POST: kill, DELETE: remove }),
}));
vi.mock("./chat/SessionChatSurface", async () => {
	const { useEffect } = await import("react");
	return {
		SessionChatSurface: ({ session, onConversationWorkChange }: { session: { id: string }; onConversationWorkChange: (state: object) => void }) => {
			useEffect(() => {
				onConversationWorkChange({ controllerBusy: false, hasRunningTurn: false, queuedTurnCount: 0 });
			}, [onConversationWorkChange]);
			return <div>Standard Chat {session.id}</div>;
		},
	};
});
vi.mock("./PageTopbar", () => ({
	PageTopbar: ({ lead, actions }: { lead: React.ReactNode; actions: React.ReactNode }) => <header>{lead}{actions}</header>,
	PageTopbarTitle: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
}));

beforeEach(() => {
	localStorage.removeItem("ao.deepWork.v1");
	useDeepWorkStore.setState({ enabled: true, side: "deep", times: ["11:00"], eligibleAfter: 0, unlockOwed: false, task: undefined });
	useLaunch.mockReset();
	useLaunch.mockReturnValue({
		canSubmit: true, chatCompatible: true, launch,
		launchSnapshot: () => ({ agent: "codex", mode: "chat" }),
		renderAgentControl: () => null,
		renderModelControl: () => null,
	});
	launch.mockReset();
	navigate.mockReset();
	read.mockReset().mockResolvedValue({ data: { session: { isTerminated: false } }, response: { status: 200 } });
	kill.mockReset().mockResolvedValue({ response: { status: 200 } });
	remove.mockReset().mockResolvedValue({ response: { status: 200 } });
});

afterEach(cleanup);

function renderPlanning() {
	const client = new QueryClient();
	const ui = () => <QueryClientProvider client={client}><DeepWorkPage workspaces={[]} /><DeepWorkSwitcher /></QueryClientProvider>;
	const view = render(ui());
	return () => view.rerender(ui());
}

const button = (name: string) => screen.getByRole("button", { name });

/** A task whose Planning Chat is already open. */
function openChatTask() {
	const store = useDeepWorkStore.getState();
	store.beginTask(STANDALONE_WORKSPACE_ID);
	const { id } = useDeepWorkStore.getState().task!;
	store.updateTask(id, { stage: "chat", planningSessionId: "planner", title: "Design the report", notes: "Journal text" });
	return id;
}

it("starts Planning Chat only on Continue, from the journal, and has no way back", async () => {
	useDeepWorkStore.getState().beginTask(STANDALONE_WORKSPACE_ID);
	launch.mockResolvedValue("planner");
	renderPlanning();

	fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Design the report" } });
	fireEvent.change(screen.getByLabelText("Planning journal"), { target: { value: "Private working notes" } });
	fireEvent.click(button("Add question"));
	fireEvent.change(screen.getByRole("textbox", { name: "Question 1" }), { target: { value: "Which format?" } });
	expect(within(screen.getByRole("region", { name: "Planning" })).getByText("Design the report")).toBeVisible();
	expect(button("Go to Shallow")).toBeDisabled();
	expect(useLaunch).not.toHaveBeenCalled();

	fireEvent.click(button("Continue"));
	expect(await screen.findByText("Standard Chat planner")).toBeVisible();
	expect(launch).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/Do not implement.*Private working notes.*Which format\?/s), {
		clientRequestId: expect.any(String), replay: { agent: "codex", mode: "chat" }, attachments: [],
	});
	expect(screen.queryByRole("button", { name: "Back to journal" })).toBeNull();
	expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
});

it("launches the worker with exactly the typed handoff and stops, but does not delete, the planner", async () => {
	openChatTask();
	launch.mockResolvedValue("builder");
	renderPlanning();

	expect(screen.queryByRole("button", { name: "Back to journal" })).toBeNull();
	fireEvent.click(button("Hand off to worker"));
	const dialog = await screen.findByRole("dialog");
	expect(within(dialog).getByLabelText("Handoff")).toHaveValue("");
	expect(within(dialog).getByRole("button", { name: "Start worker" })).toBeDisabled();

	fireEvent.change(within(dialog).getByLabelText("Handoff"), { target: { value: "Build exactly this.\n" } });
	fireEvent.click(within(dialog).getByRole("button", { name: "Start worker" }));

	await waitFor(() => expect(useDeepWorkStore.getState().task).toBeUndefined());
	expect(launch).toHaveBeenCalledExactlyOnceWith("Build exactly this.\n", expect.objectContaining({
		clientRequestId: expect.any(String),
		attachments: [],
	}));
	expect(kill).toHaveBeenCalledExactlyOnceWith("/api/v1/sessions/{sessionId}/kill", { params: { path: { sessionId: "planner" } } });
	expect(remove).not.toHaveBeenCalled();
	expect(button("Go to Shallow")).toBeEnabled();
});

it("keeps the handoff draft when the dialog is closed and reopened", async () => {
	openChatTask();
	renderPlanning();

	fireEvent.click(button("Hand off to worker"));
	fireEvent.change(within(await screen.findByRole("dialog")).getByLabelText("Handoff"), { target: { value: "Draft prompt." } });
	fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
	await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	expect(useDeepWorkStore.getState().task?.handoff).toBe("Draft prompt.");

	fireEvent.click(button("Hand off to worker"));
	expect(within(await screen.findByRole("dialog")).getByLabelText("Handoff")).toHaveValue("Draft prompt.");
	expect(launch).not.toHaveBeenCalled();
});

it("clears the task when stopping the planner fails, without a cleanup warning", async () => {
	openChatTask();
	launch.mockResolvedValue("builder");
	kill.mockRejectedValueOnce(new Error("Kill failed"));
	renderPlanning();

	fireEvent.click(button("Hand off to worker"));
	const dialog = await screen.findByRole("dialog");
	fireEvent.change(within(dialog).getByLabelText("Handoff"), { target: { value: "Build it." } });
	fireEvent.click(within(dialog).getByRole("button", { name: "Start worker" }));

	await waitFor(() => expect(useDeepWorkStore.getState().task).toBeUndefined());
	expect(launch).toHaveBeenCalledTimes(1);
	expect(screen.queryByText(/cleanup/i)).toBeNull();
	expect(remove).not.toHaveBeenCalled();
});

it("does not stop a planner that has already ended", async () => {
	openChatTask();
	launch.mockResolvedValue("builder");
	read.mockResolvedValue({ data: { session: { isTerminated: true } }, response: { status: 200 } });
	renderPlanning();

	fireEvent.click(button("Hand off to worker"));
	const dialog = await screen.findByRole("dialog");
	fireEvent.change(within(dialog).getByLabelText("Handoff"), { target: { value: "Build it." } });
	fireEvent.click(within(dialog).getByRole("button", { name: "Start worker" }));

	await waitFor(() => expect(useDeepWorkStore.getState().task).toBeUndefined());
	expect(kill).not.toHaveBeenCalled();
});

it("reuses the same worker request after a lost launch response", async () => {
	openChatTask();
	launch.mockRejectedValueOnce(new Error("Connection dropped")).mockResolvedValueOnce("builder");
	renderPlanning();

	fireEvent.click(button("Hand off to worker"));
	const dialog = await screen.findByRole("dialog");
	fireEvent.change(within(dialog).getByLabelText("Handoff"), { target: { value: "Build it." } });
	fireEvent.click(within(dialog).getByRole("button", { name: "Start worker" }));
	expect(await within(dialog).findByRole("alert")).toHaveTextContent("Connection dropped");
	expect(within(dialog).getByLabelText("Handoff")).toHaveValue("Build it.");
	expect(kill).not.toHaveBeenCalled();

	fireEvent.click(within(dialog).getByRole("button", { name: "Start worker" }));
	await waitFor(() => expect(useDeepWorkStore.getState().task).toBeUndefined());
	expect(launch).toHaveBeenCalledTimes(2);
	expect(launch.mock.calls[1]).toEqual(launch.mock.calls[0]);
});

it("discards a Planning Chat after confirmation, stopping but not deleting the planner", async () => {
	openChatTask();
	renderPlanning();

	fireEvent.click(button("Discard task"));
	fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Discard task" }));

	await waitFor(() => expect(useDeepWorkStore.getState().task).toBeUndefined());
	expect(kill).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/kill", { params: { path: { sessionId: "planner" } } });
	expect(remove).not.toHaveBeenCalled();
});

it("discards a journal without a planner after confirmation", async () => {
	useDeepWorkStore.getState().beginTask(STANDALONE_WORKSPACE_ID);
	renderPlanning();

	fireEvent.click(button("Discard task"));
	fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Discard task" }));

	await waitFor(() => expect(useDeepWorkStore.getState().task).toBeUndefined());
	expect(kill).not.toHaveBeenCalled();
});
