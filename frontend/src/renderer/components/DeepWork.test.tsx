import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDeepWorkStore } from "../stores/deep-work-store";
import { STANDALONE_WORKSPACE_ID } from "../types/workspace";
import { DeepWorkPage, DeepWorkSwitcher } from "./DeepWork";

const { useLaunch, launch, navigate } = vi.hoisted(() => ({
	useLaunch: vi.fn(),
	launch: vi.fn(),
	navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("./TaskComposer", () => ({ useTaskLaunch: useLaunch }));
vi.mock("./PageTopbar", () => ({
	PageTopbar: ({ lead, actions }: { lead: React.ReactNode; actions: React.ReactNode }) => <header>{lead}{actions}</header>,
	PageTopbarTitle: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
}));

beforeEach(() => {
	localStorage.removeItem("ao.deepWork.v1");
	useDeepWorkStore.setState({ enabled: true, side: "deep", times: ["11:00"], eligibleAfter: 0, unlockOwed: false, task: undefined });
	useLaunch.mockReturnValue({
		canSubmit: true,
		launch,
		launchSnapshot: () => ({ agent: "codex", mode: "chat" }),
		renderAgentControl: () => null,
	});
	launch.mockReset();
	navigate.mockReset();
});

afterEach(cleanup);

it("keeps brainstorming human-only and starts exactly one worker with only the explicit handoff", async () => {
	useDeepWorkStore.getState().beginTask(STANDALONE_WORKSPACE_ID);
	let finish!: (id: string) => void;
	launch.mockReturnValue(new Promise<string>((resolve) => { finish = resolve; }));
	render(
		<QueryClientProvider client={new QueryClient()}>
			<DeepWorkPage workspaces={[]} />
			<DeepWorkSwitcher />
		</QueryClientProvider>,
	);

	fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Design the report" } });
	fireEvent.change(screen.getByLabelText("Brainstorming journal"), { target: { value: "Private working notes" } });
	fireEvent.click(screen.getByRole("button", { name: "Add question" }));
	fireEvent.change(screen.getByLabelText("Question 1"), { target: { value: "Which format?" } });
	expect(within(screen.getByRole("region", { name: "Brainstorming" })).getByText("Design the report")).toBeVisible();
	expect(screen.getByRole("button", { name: "Go to Shallow" })).toBeDisabled();
	expect(useLaunch).not.toHaveBeenCalled();

	fireEvent.click(screen.getByRole("button", { name: "Finish brainstorming" }));
	expect(within(screen.getByRole("region", { name: "Alignment" })).getByText("Design the report")).toBeVisible();
	expect(screen.getByText(/Which format/)).toBeVisible();
	expect(useLaunch).toHaveBeenCalledWith({ projectId: STANDALONE_WORKSPACE_ID, prepare: false, preferChat: true });
	expect(launch).not.toHaveBeenCalled();
	fireEvent.change(screen.getByLabelText("Handoff prompt"), { target: { value: "Build the approved report." } });
	act(() => {
		const button = screen.getByRole("button", { name: "Start building" });
		button.click();
		button.click();
	});
	expect(launch).toHaveBeenCalledExactlyOnceWith("Build the approved report.", {
		clientRequestId: expect.any(String),
		replay: { agent: "codex", mode: "chat" },
		attachments: [],
	});
	await act(async () => finish("scratchpad-1"));
	expect(useDeepWorkStore.getState().task).toBeUndefined();
	expect(screen.getByRole("button", { name: "Go to Shallow" })).toBeEnabled();
});

it("holds the journal and retries a lost launch response with the same request", async () => {
	const store = useDeepWorkStore.getState();
	store.beginTask(STANDALONE_WORKSPACE_ID);
	const { id } = useDeepWorkStore.getState().task!;
	store.updateTask(id, { stage: "alignment", notes: "Working notes", handoff: "Build it." });
	launch.mockRejectedValueOnce(new Error("Connection dropped")).mockResolvedValueOnce("scratchpad-1");
	render(<QueryClientProvider client={new QueryClient()}><DeepWorkPage workspaces={[]} /></QueryClientProvider>);

	fireEvent.click(screen.getByRole("button", { name: "Start building" }));
	expect(await screen.findByRole("alert")).toHaveTextContent("Connection dropped");
	expect(screen.getByText(/Working notes/)).toBeVisible();
	expect(screen.getByLabelText("Handoff prompt")).toHaveValue("Build it.");
	fireEvent.click(screen.getByRole("button", { name: "Retry Start building" }));
	await waitFor(() => expect(useDeepWorkStore.getState().task).toBeUndefined());
	expect(launch.mock.calls[1]).toEqual(launch.mock.calls[0]);
});
