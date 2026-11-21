import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDeepWorkStore } from "../stores/deep-work-store";
import { STANDALONE_WORKSPACE_ID } from "../types/workspace";
import { DeepWorkPage, DeepWorkSwitcher } from "./DeepWork";

const { useLaunch, launch, send, navigate, read, kill, remove, chat } = vi.hoisted(() => ({
	useLaunch: vi.fn(), launch: vi.fn(), send: vi.fn(), navigate: vi.fn(),
	read: vi.fn(), kill: vi.fn(), remove: vi.fn(),
	chat: { snapshot: undefined as unknown },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("./TaskComposer", () => ({ useTaskLaunch: useLaunch }));
vi.mock("../hooks/useWorkspaceQuery", () => ({
	workspaceQueryKeyForHost: () => ["workspaces"],
	useWorkspaceSession: (id: string) => ({ data: { id } }),
}));
vi.mock("../hooks/useConversation", () => ({
	useConversation: () => chat,
	useConversationCommands: () => ({ send, sendPending: false }),
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
	send.mockReset();
	navigate.mockReset();
	read.mockReset().mockResolvedValue({ data: { session: { isTerminated: false } }, response: { status: 200 } });
	kill.mockReset().mockResolvedValue({ response: { status: 200 } });
	remove.mockReset().mockResolvedValue({ response: { status: 200 } });
	chat.snapshot = undefined;
});

afterEach(cleanup);

function renderPlanning() {
	const client = new QueryClient();
	const ui = () => <QueryClientProvider client={client}><DeepWorkPage workspaces={[]} /><DeepWorkSwitcher /></QueryClientProvider>;
	const view = render(ui());
	return () => view.rerender(ui());
}

const button = (name: string) => screen.getByRole("button", { name });

it("starts the scoped Chat only on Continue and resends only new journal context", async () => {
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
	expect(send).not.toHaveBeenCalled();

	fireEvent.click(button("Continue"));
	expect(await screen.findByText("Standard Chat planner")).toBeVisible();
	expect(launch).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/Do not implement.*Private working notes.*Which format\?/s), {
		clientRequestId: expect.any(String), replay: { agent: "codex", mode: "chat" }, attachments: [],
	});
	fireEvent.click(button("Back to journal"));
	expect(screen.getByLabelText("Planning journal")).toHaveValue("Private working notes");
	fireEvent.click(button("Continue"));
	expect(await screen.findByText("Standard Chat planner")).toBeVisible();
	expect(send).not.toHaveBeenCalled();
	fireEvent.click(button("Back to journal"));
	fireEvent.change(screen.getByLabelText("Planning journal"), { target: { value: "Private working notes\nUse a table." } });
	send.mockResolvedValue({ turnId: "update" });
	fireEvent.click(button("Continue"));
	expect(await screen.findByText("Standard Chat planner")).toBeVisible();
	const message = send.mock.calls[0][0].text;
	expect(message).toContain("Use a table.");
	expect(message).not.toContain("Private working notes");
	expect(message).not.toContain("Which format?");
	expect(send).toHaveBeenCalledTimes(1);
	expect(launch).toHaveBeenCalledTimes(1);
});

it("prepares a review from the same Chat and launches only the exact confirmed handoff", async () => {
	const store = useDeepWorkStore.getState();
	store.beginTask(STANDALONE_WORKSPACE_ID);
	const { id } = useDeepWorkStore.getState().task!;
	store.updateTask(id, { stage: "chat", planningSessionId: "planner", notes: "Journal text" });
	send.mockResolvedValue({ turnId: "prepare" });
	const rerender = renderPlanning();
	fireEvent.click(button("Prepare for worker"));
	await waitFor(() => expect(useDeepWorkStore.getState().task?.generation?.turnId).toBe("prepare"));
	expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("Do not implement") }));
	expect(launch).not.toHaveBeenCalled();
	chat.snapshot = {
		sessionId: "planner",
		turns: [{ id: "prepare", state: "completed" }],
		items: [
			{ kind: "message", role: "assistant", turnId: "other", text: "Unrelated answer" },
			{ kind: "message", role: "assistant", turnId: "prepare", text: "Generated handoff" },
		],
	};
	rerender();
	expect(await screen.findByLabelText("Handoff prompt")).toHaveValue("Generated handoff");
	expect(launch).not.toHaveBeenCalled();
	fireEvent.change(screen.getByLabelText("Handoff prompt"), { target: { value: "Edited prompt.\n" } });
	fireEvent.click(button("Back to Planning Chat"));
	expect(await screen.findByText("Standard Chat planner")).toBeVisible();
	fireEvent.click(button("Prepare for worker"));
	expect(await screen.findByLabelText("Handoff prompt")).toHaveValue("Edited prompt.\n");
	expect(send).toHaveBeenCalledTimes(1);

	launch.mockResolvedValue("builder");
	act(() => {
		const confirm = button("Confirm and start worker");
		confirm.click();
		confirm.click();
	});
	await waitFor(() => expect(useDeepWorkStore.getState().task).toBeUndefined());
	expect(launch).toHaveBeenCalledExactlyOnceWith("Edited prompt.\n", expect.objectContaining({
		clientRequestId: expect.any(String),
		attachments: [],
	}));
	expect(kill).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/kill", { params: { path: { sessionId: "planner" } } });
	expect(remove).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}", { params: { path: { sessionId: "planner" }, query: { cleanup: true } } });
	expect(button("Go to Shallow")).toBeEnabled();
});

it("reuses a lost launch request and never starts a second worker on cleanup retry", async () => {
	const store = useDeepWorkStore.getState();
	store.beginTask(STANDALONE_WORKSPACE_ID);
	const { id } = useDeepWorkStore.getState().task!;
	store.updateTask(id, { stage: "handoff", planningSessionId: "planner", handoff: "Build it.", notes: "Keep until success" });
	launch.mockRejectedValueOnce(new Error("Connection dropped")).mockResolvedValueOnce("builder");
	remove.mockRejectedValueOnce(new Error("Cleanup pending"));
	renderPlanning();

	fireEvent.click(button("Confirm and start worker"));
	expect(await screen.findByRole("alert")).toHaveTextContent("Connection dropped");
	expect(screen.getByLabelText("Handoff prompt")).toHaveValue("Build it.");
	expect(kill).not.toHaveBeenCalled();
	fireEvent.click(button("Retry Confirm"));
	expect(await screen.findByRole("alert")).toHaveTextContent("Cleanup pending");
	expect(launch.mock.calls[1]).toEqual(launch.mock.calls[0]);
	expect(useDeepWorkStore.getState().task?.notes).toBe("Keep until success");
	fireEvent.click(button("Retry cleanup"));
	await waitFor(() => expect(useDeepWorkStore.getState().task).toBeUndefined());
	expect(launch).toHaveBeenCalledTimes(2);
});

it("retries a failed generation on the same Chat without launching a worker", async () => {
	const store = useDeepWorkStore.getState();
	store.beginTask(STANDALONE_WORKSPACE_ID);
	const { id } = useDeepWorkStore.getState().task!;
	store.updateTask(id, { stage: "chat", planningSessionId: "planner" });
	send.mockRejectedValueOnce(new Error("Connection dropped")).mockResolvedValueOnce({ turnId: "retry" });
	renderPlanning();

	fireEvent.click(button("Prepare for worker"));
	expect(await screen.findByRole("alert")).toHaveTextContent("Connection dropped");
	fireEvent.click(button("Retry handoff request"));
	await waitFor(() => expect(useDeepWorkStore.getState().task?.generation?.turnId).toBe("retry"));
	expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
	expect(launch).not.toHaveBeenCalled();
});
