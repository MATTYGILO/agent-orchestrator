import { BoardColumnFrame } from "@aoagents/product-ui";
import { ArrowLeft, ArrowRight, Lock, Plus, X } from "@/components/app-icons";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspaceSession, workspaceQueryKeyForHost } from "../hooks/useWorkspaceQuery";
import { shallowUnlock, useDeepWorkStore, type DeepWorkTask } from "../stores/deep-work-store";
import { useUiStore } from "../stores/ui-store";
import { CLOUD_PROJECT_KIND, CLOUD_STANDALONE_WORKSPACE_ID, isScratchpadWorkspace, STANDALONE_WORKSPACE_ID, type WorkspaceSummary } from "../types/workspace";
import { clientForSessionHost, labelForHost } from "../lib/host-clients";
import { apiErrorException } from "../lib/api-error-exception";
import { useConversation, useConversationCommands } from "../hooks/useConversation";
import { planningContext, planningJournal } from "../lib/planning-journal";
import { SessionChatSurface } from "./chat/SessionChatSurface";
import { sendIsUncertain } from "../lib/task-launch-outcome";
import { PageTopbar, PageTopbarTitle } from "./PageTopbar";
import { useTaskLaunch } from "./TaskComposer";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ConfirmDialog";
import { Input } from "./ui/input";

const fieldClass = "mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground";

export function DeepWorkSwitcher() {
	const navigate = useNavigate();
	const state = useDeepWorkStore();
	const settingsOpen = useUiStore((store) => store.settingsModal !== null);
	const [clockRevision, tick] = useState(0);
	const { due, next } = shallowUnlock(state);
	const nextAt = next?.getTime();
	useEffect(() => {
		if (!state.enabled || state.side !== "deep" || due || nextAt === undefined) return;
		const refresh = () => tick((value) => value + 1);
		// The minute check also picks up changes to the computer's clock and timezone.
		const timer = window.setTimeout(refresh, Math.max(1, Math.min(60_000, nextAt - Date.now())));
		window.addEventListener("focus", refresh);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			window.clearTimeout(timer);
			window.removeEventListener("focus", refresh);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, [state.enabled, state.side, due, nextAt, clockRevision]);
	if (!state.enabled || settingsOpen) return null;

	const shallow = state.side === "shallow";
	const label = shallow ? "Return to Deep" : due ? "Go to Shallow" : next
		? `Locked until ${next.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
		: "Locked · No times scheduled";
	return (
		<div className="pointer-events-none absolute bottom-4 right-4 z-20">
			<Button
				type="button"
				variant="secondary"
				className="pointer-events-auto gap-2 rounded-full border border-border bg-popover shadow-md"
				disabled={Boolean(state.task) || (!shallow && !due)}
				title={state.task ? "Finish or discard the current task to switch sides." : undefined}
				onClick={() => {
					if (!state.switchSide()) return;
					useUiStore.getState().clearGlobalToast();
					void navigate({ to: "/", replace: true });
				}}
			>
				{shallow ? <ArrowLeft className="size-4" aria-hidden /> : due ? <ArrowRight className="size-4" aria-hidden /> : <Lock className="size-4" aria-hidden />}
				{label}
			</Button>
		</div>
	);
}

export function DeepWorkPage({ workspaces }: { workspaces: WorkspaceSummary[] }) {
	const task = useDeepWorkStore((state) => state.task);
	const storageError = useDeepWorkStore((state) => state.storageError);

	return (
		<div className="flex h-full min-h-0 flex-col bg-background" data-testid="deep-work-board">
			<PageTopbar
				lead={<PageTopbarTitle as="h1">Deep</PageTopbarTitle>}
				actions={(
					<>
						{!task ? <Button type="button" size="sm" variant="primary" onClick={() => useUiStore.getState().requestNewTask(STANDALONE_WORKSPACE_ID)}>
							<Plus aria-hidden className="size-4" /> New task
						</Button> : null}
						<Button type="button" size="sm" variant="quiet" onClick={() => useUiStore.getState().openGlobalSettings("general")}>Settings</Button>
					</>
				)}
			/>
			<div className={task ? "grid h-28 shrink-0 border-b border-border-strong" : "grid min-h-0 flex-1"}>
				<BoardColumnFrame id="planning" label="Planning" dot="var(--color-status-working)" count={Number(Boolean(task))}>
					{task ? <div className="truncate rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium">{task.title.trim() || "Untitled task"}</div> : null}
				</BoardColumnFrame>
			</div>
			{storageError ? <p role="alert" className="px-4 py-2 text-sm text-destructive">{storageError}</p> : null}
			{task?.stage === "handoff" && task.planningSessionId ? (
				<WorkerHandoffReview key={task.id} task={task} />
			) : task?.stage === "chat" && task.planningSessionId ? (
				<PlanningChat key={task.id} task={task} sessionId={task.planningSessionId} />
			) : task ? <DeepWorkJournal key={task.id} task={task} workspaces={workspaces} /> : null}
		</div>
	);
}

function DeepWorkJournal({ task, workspaces }: { task: DeepWorkTask; workspaces: WorkspaceSummary[] }) {
	const [discardOpen, setDiscardOpen] = useState(false);
	const [starting, setStarting] = useState(false);
	const [launchRequested, setLaunchRequested] = useState(false);
	const [discarding, setDiscarding] = useState(false);
	const [discardError, setDiscardError] = useState<string>();
	const queryClient = useQueryClient();
	const update = useDeepWorkStore((state) => state.updateTask);
	const targets = [
		{ id: STANDALONE_WORKSPACE_ID, name: "Scratchpad", hostId: undefined },
		...workspaces.filter((workspace) => workspace.kind !== CLOUD_PROJECT_KIND && !isScratchpadWorkspace(workspace) && !workspace.shared && !workspace.standaloneAgent),
	];
	const keyFor = (target: { id: string; hostId?: string }) => JSON.stringify([target.hostId, target.id]);
	const targetKey = keyFor({ id: task.projectId, hostId: task.hostId });
	const supportedTarget = targets.some((target) => keyFor(target) === targetKey);
	const fieldsLocked = Boolean(task.pending) || launchRequested || starting || discarding;
	const discard = async () => {
		if (discarding || starting) return;
		setDiscarding(true);
		setDiscardError(undefined);
		try {
			await cleanUpPlanner(task);
			void queryClient.invalidateQueries({ queryKey: workspaceQueryKeyForHost(task.hostId) });
			useDeepWorkStore.getState().clearTask(task.id);
		} catch (cause) {
			setDiscardError(cause instanceof Error ? cause.message : "The planning session could not be removed.");
		} finally {
			setDiscarding(false);
		}
	};

	return (
		<div className="min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 pb-20 pt-5">
				<label className="text-sm font-medium">Task title
					<Input className="mt-1" value={task.title} readOnly={fieldsLocked} onChange={(event) => update(task.id, { title: event.target.value })} />
				</label>
				<label className="text-sm font-medium">Planning journal
					<textarea className={fieldClass} rows={7} value={task.notes} readOnly={fieldsLocked}
						onChange={(event) => update(task.id, { notes: event.target.value })} />
				</label>
				<fieldset className="flex min-w-0 flex-col gap-2" disabled={fieldsLocked}>
					<legend className="mb-2 text-sm font-medium">Queued questions</legend>
					{task.questions.map((question, index) => (
						<div className="flex gap-2" key={index}>
							<Input aria-label={`Question ${index + 1}`} value={question}
								onChange={(event) => update(task.id, { questions: task.questions.map((value, position) => position === index ? event.target.value : value) })} />
							<Button type="button" size="sm" variant="quiet" aria-label={`Remove question ${index + 1}`}
								onClick={() => update(task.id, { questions: task.questions.filter((_, position) => position !== index) })}>
								<X className="size-4" aria-hidden />
							</Button>
						</div>
					))}
					<Button type="button" size="sm" variant="secondary" className="self-start"
						onClick={() => update(task.id, { questions: [...task.questions, ""] })}>Add question</Button>
				</fieldset>
				<label className="text-sm font-medium">Project
					<select className={fieldClass} value={targetKey} disabled={fieldsLocked || Boolean(task.planningSessionId)} onChange={(event) => {
						const target = targets.find((entry) => keyFor(entry) === event.target.value);
						if (target) update(task.id, { projectId: target.id, hostId: target.hostId });
					}}>
						{supportedTarget ? null : <option value={targetKey}>{task.projectId === CLOUD_STANDALONE_WORKSPACE_ID ? "Cloud standalone agent" : task.projectId}</option>}
						{targets.map((target) => <option key={keyFor(target)} value={keyFor(target)}>{target.name}{target.hostId ? ` · ${labelForHost(target.hostId) ?? target.hostId}` : ""}</option>)}
					</select>
				</label>
				{!supportedTarget && !task.planningSessionId ? <p className="text-sm text-muted-foreground">Choose a local or paired project to open Planning Chat.</p> : null}
				<div className="flex flex-wrap items-start justify-between gap-3">
					<Button type="button" size="sm" variant="quiet" disabled={starting || launchRequested || task.pending?.kind === "start"} onClick={() => setDiscardOpen(true)}>Discard task</Button>
					{task.planningSessionId ? (
						<PlanningContinue task={task} sessionId={task.planningSessionId} onStarting={setStarting} disabled={discarding} />
					) : launchRequested ? (
						<PlanningLaunch task={task} onStarting={setStarting} onBack={() => setLaunchRequested(false)} />
					) : (
						<Button size="sm" variant="primary" disabled={!supportedTarget || discarding} onClick={() => setLaunchRequested(true)}>
							{task.pending ? "Retry Continue" : "Continue"}
						</Button>
					)}
				</div>
				<ConfirmDialog
					open={discardOpen}
					onOpenChange={setDiscardOpen}
					title="Discard this task?"
					description={task.planningSessionId
						? "The journal and conversation will be deleted after the planning workspace is safely released."
						: "The journal and queued questions will be deleted."}
					confirmLabel="Discard task"
					destructive
					busy={discarding}
					error={discardError}
					onConfirm={() => void discard()}
				/>
			</div>
		</div>
	);
}

function PlanningLaunch({ task, onStarting, onBack }: { task: DeepWorkTask; onStarting: (running: boolean) => void; onBack: () => void }) {
	const launch = useTaskLaunch({ projectId: task.projectId, hostId: task.hostId, prepare: false, preferChat: true, chatOnly: true });
	const queryClient = useQueryClient();
	const inFlight = useRef(false);
	const attempted = useRef(false);
	const [error, setError] = useState<string>();
	const { pending } = task;
	const start = async () => {
		if ((!launch.canSubmit && pending?.kind !== "start") || inFlight.current) return;
		inFlight.current = true;
		attempted.current = true;
		onStarting(true);
		setError(undefined);
		const store = useDeepWorkStore.getState();
		const journal = planningJournal(task);
		const request = pending?.kind === "start" ? pending : {
			kind: "start" as const,
			requestId: crypto.randomUUID(),
			replay: { ...launch.launchSnapshot(), mode: "chat" as const },
			text: planningContext(journal),
			journal,
		};
		try {
			if (!store.updateTask(task.id, { pending: request })) return;
			const sessionId = await launch.launch(request.text, { clientRequestId: request.requestId, replay: request.replay, attachments: [] });
			store.updateTask(task.id, { planningSessionId: sessionId, delivered: request.journal, pending: undefined, stage: "chat" });
			void queryClient.invalidateQueries({ queryKey: workspaceQueryKeyForHost(task.hostId) });
		} catch (cause) {
			if (!pending && !sendIsUncertain(cause)) store.updateTask(task.id, { pending: undefined });
			setError(cause instanceof Error ? cause.message : "Planning Chat could not be started.");
		} finally {
			inFlight.current = false;
			onStarting(false);
		}
	};
	useEffect(() => {
		if (!attempted.current && launch.canSubmit) void start();
	});
	return (
		<div className="flex min-w-0 flex-1 flex-col items-end gap-2">
			{launch.isSubmitting ? <p role="status" className="text-sm text-muted-foreground">Starting Planning Chat…</p> : null}
			{error || launch.remoteLoadError ? <p role="alert" className="text-sm text-destructive">{error ?? launch.remoteLoadError}</p> : null}
			{!pending && !launch.isSubmitting ? launch.renderAgentControl({ ...launch.agent, id: "deep-work-agent" }) : null}
			{!pending && !launch.chatCompatible ? <p className="text-sm text-muted-foreground">Planning requires a Chat-capable agent.</p> : null}
			<div className="flex gap-2">
				<Button size="sm" variant="quiet" disabled={launch.isSubmitting} onClick={onBack}>Back to journal</Button>
				<Button size="sm" variant="primary" disabled={!launch.canSubmit || launch.isSubmitting} onClick={() => void start()}>Open Planning Chat</Button>
			</div>
		</div>
	);
}

function PlanningContinue({ task, sessionId, disabled, onStarting }: {
	task: DeepWorkTask;
	sessionId: string;
	disabled: boolean;
	onStarting: (running: boolean) => void;
}) {
	const { send } = useConversationCommands(sessionId, task.hostId);
	const inFlight = useRef(false);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string>();
	const resume = async () => {
		if (inFlight.current) return;
		const store = useDeepWorkStore.getState();
		const journal = planningJournal(task);
		const text = planningContext(journal, task.delivered);
		const pending = task.pending?.kind === "update" ? task.pending : undefined;
		if (!pending && !text) {
			store.updateTask(task.id, { stage: "chat" });
			return;
		}
		const request = pending ?? { kind: "update" as const, requestId: crypto.randomUUID(), text, journal };
		inFlight.current = true;
		setSending(true);
		onStarting(true);
		setError(undefined);
		try {
			if (!store.updateTask(task.id, { pending: request })) return;
			await send({ text: request.text, clientMessageId: request.requestId });
			store.updateTask(task.id, { delivered: request.journal, pending: undefined, stage: "chat" });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "The planning journal could not be sent.");
		} finally {
			inFlight.current = false;
			setSending(false);
			onStarting(false);
		}
	};
	return (
		<div className="flex flex-col items-end gap-2">
			{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
			<Button size="sm" variant="primary" disabled={disabled || sending} onClick={() => void resume()}>
				{sending ? "Sending journal…" : task.pending ? "Retry Continue" : "Continue"}
			</Button>
		</div>
	);
}

const HANDOFF_REQUEST = "Prepare a self-contained handoff prompt for a fresh implementation worker based on this planning conversation. Include the agreed scope, relevant project context, constraints, decisions and verification steps. Make uncertainty explicit. Reply with the handoff text only. Do not implement, change files, make commits or launch a worker.";

function PlanningChat({ task, sessionId }: { task: DeepWorkTask; sessionId: string }) {
	const { data: session, isLoading } = useWorkspaceSession(sessionId, task.hostId);
	const { snapshot } = useConversation(sessionId, task.hostId);
	const { send, sendPending } = useConversationCommands(sessionId, task.hostId);
	const update = useDeepWorkStore((state) => state.updateTask);
	const [busy, setBusy] = useState(true);
	const [generationError, setGenerationError] = useState<string>();
	const generating = useRef(false);
	const generation = task.generation;
	const workChanged = useCallback(({ controllerBusy, hasRunningTurn, queuedTurnCount }: {
		controllerBusy: boolean;
		hasRunningTurn: boolean;
		queuedTurnCount: number;
	}) => setBusy(controllerBusy || hasRunningTurn || queuedTurnCount > 0), []);

	useEffect(() => {
		if (!generation || !snapshot || snapshot.sessionId !== sessionId) return;
		const message = snapshot.items.find((item) => item.kind === "message" && item.role === "user" && item.clientMessageId === generation.requestId);
		const turnId = generation.turnId ?? message?.turnId;
		const turn = snapshot.turns.find((candidate) => candidate.id === turnId);
		if (!turn || turn.state === "queued" || turn.state === "running") return;
		const output = snapshot.items.flatMap((item) => item.kind === "message" && item.turnId === turnId &&
			item.role === "assistant" && !item.streaming && item.text.trim() ? [item.text] : []).join("\n\n");
		if ((turn.state === "completed" || turn.state === "recovered") && output) {
			update(task.id, { generation: undefined, handoff: output, stage: "handoff" });
		} else if (update(task.id, { generation: undefined })) {
			setGenerationError("The planning agent did not return a handoff. Prepare for worker to try again.");
		}
	}, [generation, sessionId, snapshot, task.id, update]);

	const prepare = async () => {
		if (generating.current || generation?.turnId) return;
		const latest = useDeepWorkStore.getState();
		if (latest.task?.handoff !== undefined) {
			update(task.id, { stage: "handoff" });
			return;
		}
		const request = generation ?? { requestId: crypto.randomUUID() };
		generating.current = true;
		setGenerationError(undefined);
		try {
			if (!update(task.id, { generation: request })) return;
			const reply = await send({ text: HANDOFF_REQUEST, clientMessageId: request.requestId });
			// A reply may have arrived after the transcript observer already opened
			// the review. Keep the finished result and never re-arm its request.
			if (reply?.turnId && useDeepWorkStore.getState().task?.generation?.requestId === request.requestId) {
				update(task.id, { generation: { ...request, turnId: reply.turnId } });
			}
		} catch (cause) {
			setGenerationError(cause instanceof Error ? cause.message : "The handoff request could not be delivered. Retry with the same request.");
		} finally {
			generating.current = false;
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col pb-14">
			<div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2">
				<h2 className="text-sm font-medium">Planning Chat</h2>
				<div className="flex gap-2">
					<Button size="sm" variant="quiet" disabled={Boolean(session && busy) || sendPending || Boolean(generation?.turnId)}
						onClick={() => update(task.id, { stage: "journal", generation: undefined })}>Back to journal</Button>
					<Button size="sm" variant="primary" disabled={!session || busy || sendPending || Boolean(generation?.turnId)} onClick={() => void prepare()}>
						{generation?.turnId || sendPending ? "Preparing handoff…" : generation ? "Retry handoff request" : "Prepare for worker"}
					</Button>
				</div>
			</div>
			{generationError ? <p role="alert" className="px-4 py-2 text-sm text-destructive">{generationError}</p> : null}
			{session ? <SessionChatSurface session={session} hostId={task.hostId} daemonReady planning newWorkDisabled={Boolean(generation)} onConversationWorkChange={workChanged} />
				: <p role="status" className="p-4 text-sm text-muted-foreground">{isLoading ? "Loading Planning Chat…" : "The planning session is unavailable."}</p>}
		</div>
	);
}

async function cleanUpPlanner(task: DeepWorkTask) {
	if (!task.planningSessionId) return;
	const client = clientForSessionHost(task.hostId);
	const path = { sessionId: task.planningSessionId };
	const current = await client.GET("/api/v1/sessions/{sessionId}", { params: { path } });
	if (current.response.status === 404) return;
	if (current.error) throw apiErrorException(current.error);
	if (!current.data?.session?.isTerminated) {
		const stopped = await client.POST("/api/v1/sessions/{sessionId}/kill", { params: { path } });
		if (stopped.response.status === 404) return;
		if (stopped.error) throw apiErrorException(stopped.error);
	}
	const deleted = await client.DELETE("/api/v1/sessions/{sessionId}", { params: { path, query: { cleanup: true } } });
	if (deleted.error && deleted.response.status !== 404) throw apiErrorException(deleted.error);
}

function WorkerHandoffReview({ task }: { task: DeepWorkTask }) {
	const launch = useTaskLaunch({ projectId: task.projectId, hostId: task.hostId, preferChat: true, prepare: false });
	const queryClient = useQueryClient();
	const update = useDeepWorkStore((state) => state.updateTask);
	const inFlight = useRef(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const { buildRequest, workerSessionId } = task;
	const text = task.handoff ?? "";

	const confirm = async (useTerminal = false) => {
		if (inFlight.current || (!workerSessionId && (!text.trim() || !launch.canSubmit))) return;
		inFlight.current = true;
		setBusy(true);
		setError(undefined);
		const store = useDeepWorkStore.getState();
		let workerId = workerSessionId;
		try {
			if (!workerId) {
				const replay = launch.launchSnapshot();
				const request = buildRequest ?? { requestId: crypto.randomUUID(), text, replay: { ...replay, ...(useTerminal ? { mode: "tui" as const } : {}) } };
				if (!update(task.id, { buildRequest: request })) return;
				workerId = await launch.launch(request.text, { clientRequestId: request.requestId, replay: request.replay, attachments: [] });
				// Persist the accepted worker before touching the planner. A relaunch
				// can retry cleanup without replaying the launch.
				if (!update(task.id, { workerSessionId: workerId })) return;
			}
			await cleanUpPlanner(task);
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKeyForHost(task.hostId) });
			store.clearTask(task.id);
		} catch (cause) {
			if (!workerId && !buildRequest && !sendIsUncertain(cause)) update(task.id, { buildRequest: undefined });
			const reason = cause instanceof Error ? cause.message : "Try again.";
			setError(workerId ? `The worker started. Planning cleanup still needs attention. ${reason}` : reason);
		} finally {
			inFlight.current = false;
			setBusy(false);
		}
	};

	const locked = Boolean(buildRequest || workerSessionId);
	const recovery = !locked && (launch.error ? launch.errorAction : launch.remoteLoadErrorAction);
	const recoveryInput = !locked && launch.error ? launch.errorAction?.input : undefined;
	return (
		<div className="min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 pb-20 pt-5">
				<h2 className="text-base font-semibold">Review worker handoff</h2>
				{workerSessionId ? <p role="status" className="text-sm text-muted-foreground">The worker has started. Finish cleaning up Planning to release this task.</p> : null}
				<label className="text-sm font-medium">Handoff prompt
					<textarea className={fieldClass} rows={12} value={text} readOnly={locked || busy}
						onChange={(event) => update(task.id, { handoff: event.target.value })} />
				</label>
				{!locked ? <div className="flex flex-wrap items-center gap-2">
					{launch.renderAgentControl({ ...launch.agent, id: "deep-work-worker-agent" })}
					{launch.renderModelControl({ ...launch.model, id: "deep-work-worker-model" })}
					{launch.showEffort ? launch.renderEffortControl({ ...launch.effort, id: "deep-work-worker-effort", label: "Reasoning effort" }) : null}
				</div> : null}
				{error || (!locked && launch.remoteLoadError) ? <p role="alert" className="text-sm text-destructive">{error ?? launch.remoteLoadError}</p> : null}
				{recoveryInput ? <Input aria-label={recoveryInput.label} value={recoveryInput.value}
					onChange={(event) => recoveryInput.onChange(event.target.value)} /> : null}
				<div className="flex flex-wrap justify-end gap-2">
					<Button size="sm" variant="quiet" disabled={busy || locked} onClick={() => update(task.id, { stage: "chat" })}>Back to Planning Chat</Button>
					{recovery ? <Button size="sm" variant="secondary" onClick={recovery.onClick}>{recovery.label}</Button> : null}
					{!locked && launch.fallbackAction === "tui" ? <Button size="sm" variant="secondary" onClick={() => void confirm(true)}>Confirm and start in Terminal</Button> : null}
					<Button size="sm" variant="primary" disabled={busy || (!workerSessionId && (!text.trim() || !launch.canSubmit))} onClick={() => void confirm()}>
						{busy ? "Working…" : workerSessionId ? "Retry cleanup" : buildRequest ? "Retry Confirm" : "Confirm and start worker"}
					</Button>
				</div>
			</div>
		</div>
	);
}
