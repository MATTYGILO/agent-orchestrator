import { BoardColumnFrame } from "@aoagents/product-ui";
import { ArrowLeft, ArrowRight, Lock, Plus, X } from "@/components/app-icons";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useWorkspaceSession, workspaceQueryKeyForHost } from "../hooks/useWorkspaceQuery";
import { shallowUnlock, useDeepWorkStore, type DeepWorkTask } from "../stores/deep-work-store";
import { useUiStore } from "../stores/ui-store";
import { CLOUD_PROJECT_KIND, CLOUD_STANDALONE_WORKSPACE_ID, isScratchpadWorkspace, STANDALONE_WORKSPACE_ID, type WorkspaceSummary } from "../types/workspace";
import { clientForSessionHost, labelForHost } from "../lib/host-clients";
import { apiErrorException } from "../lib/api-error-exception";
import { planningContext, planningJournal } from "../lib/planning-journal";
import { SessionChatSurface } from "./chat/SessionChatSurface";
import { sendIsUncertain } from "../lib/task-launch-outcome";
import { PageTopbar, PageTopbarTitle } from "./PageTopbar";
import { useTaskLaunch } from "./TaskComposer";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ConfirmDialog";
import { Input } from "./ui/input";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogTitle,
	settingsDialogBodyClass,
	settingsDialogContentClass,
	settingsDialogFooterClass,
	settingsDialogHeaderClass,
} from "./ui/dialog";

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
			{task?.stage === "chat" && task.planningSessionId ? (
				<PlanningChat key={task.id} task={task} sessionId={task.planningSessionId} />
			) : task ? <DeepWorkJournal key={task.id} task={task} workspaces={workspaces} /> : null}
		</div>
	);
}

function DeepWorkJournal({ task, workspaces }: { task: DeepWorkTask; workspaces: WorkspaceSummary[] }) {
	const [starting, setStarting] = useState(false);
	const [launchRequested, setLaunchRequested] = useState(false);
	const update = useDeepWorkStore((state) => state.updateTask);
	const targets = [
		{ id: STANDALONE_WORKSPACE_ID, name: "Scratchpad", hostId: undefined },
		...workspaces.filter((workspace) => workspace.kind !== CLOUD_PROJECT_KIND && !isScratchpadWorkspace(workspace) && !workspace.shared && !workspace.standaloneAgent),
	];
	const keyFor = (target: { id: string; hostId?: string }) => JSON.stringify([target.hostId, target.id]);
	const targetKey = keyFor({ id: task.projectId, hostId: task.hostId });
	const supportedTarget = targets.some((target) => keyFor(target) === targetKey);
	const fieldsLocked = Boolean(task.pending) || launchRequested || starting;

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
					<select className={fieldClass} value={targetKey} disabled={fieldsLocked} onChange={(event) => {
						const target = targets.find((entry) => keyFor(entry) === event.target.value);
						if (target) update(task.id, { projectId: target.id, hostId: target.hostId });
					}}>
						{supportedTarget ? null : <option value={targetKey}>{task.projectId === CLOUD_STANDALONE_WORKSPACE_ID ? "Cloud standalone agent" : task.projectId}</option>}
						{targets.map((target) => <option key={keyFor(target)} value={keyFor(target)}>{target.name}{target.hostId ? ` · ${labelForHost(target.hostId) ?? target.hostId}` : ""}</option>)}
					</select>
				</label>
				{!supportedTarget ? <p className="text-sm text-muted-foreground">Choose a local or paired project to open Planning Chat.</p> : null}
				<div className="flex flex-wrap items-start justify-between gap-3">
					<DiscardTaskButton task={task} disabled={starting || launchRequested || Boolean(task.pending)} />
					{launchRequested ? (
						<PlanningLaunch task={task} onStarting={setStarting} onBack={() => setLaunchRequested(false)} />
					) : (
						<Button size="sm" variant="primary" disabled={!supportedTarget} onClick={() => setLaunchRequested(true)}>
							{task.pending ? "Retry Continue" : "Continue"}
						</Button>
					)}
				</div>
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
			store.updateTask(task.id, { planningSessionId: sessionId, pending: undefined, stage: "chat" });
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
				<Button size="sm" variant="quiet" disabled={launch.isSubmitting || Boolean(pending)} onClick={onBack}>Back to journal</Button>
				<Button size="sm" variant="primary" disabled={!launch.canSubmit || launch.isSubmitting} onClick={() => void start()}>Open Planning Chat</Button>
			</div>
		</div>
	);
}

/**
 * Stops the planning session so it stops spending. It is never deleted, archived
 * or cleaned up, and its worktree is left alone.
 */
async function stopPlanner(task: DeepWorkTask) {
	if (!task.planningSessionId) return;
	const client = clientForSessionHost(task.hostId);
	const path = { sessionId: task.planningSessionId };
	const current = await client.GET("/api/v1/sessions/{sessionId}", { params: { path } });
	if (current.response.status === 404) return;
	if (current.error) throw apiErrorException(current.error);
	if (current.data?.session?.isTerminated) return;
	const stopped = await client.POST("/api/v1/sessions/{sessionId}/kill", { params: { path } });
	if (stopped.response.status === 404) return;
	if (stopped.error) throw apiErrorException(stopped.error);
}

/**
 * Discards the task. The planner is stopped, not deleted, and a failure to stop it
 * never keeps the task around.
 */
function DiscardTaskButton({ task, disabled }: { task: DeepWorkTask; disabled?: boolean }) {
	const [open, setOpen] = useState(false);
	const [discarding, setDiscarding] = useState(false);
	const queryClient = useQueryClient();
	const discard = async () => {
		if (discarding) return;
		setDiscarding(true);
		await stopPlanner(task).catch(() => undefined);
		void queryClient.invalidateQueries({ queryKey: workspaceQueryKeyForHost(task.hostId) });
		useDeepWorkStore.getState().clearTask(task.id);
	};

	return (
		<>
			<Button type="button" size="sm" variant="quiet" disabled={disabled || discarding} onClick={() => setOpen(true)}>Discard task</Button>
			<ConfirmDialog
				open={open}
				onOpenChange={setOpen}
				title="Discard this task?"
				description={task.planningSessionId
					? "The journal and handoff draft are deleted and Planning Chat is stopped. The planning session is kept."
					: "The journal and queued questions will be deleted."}
				confirmLabel="Discard task"
				destructive
				busy={discarding}
				onConfirm={() => void discard()}
			/>
		</>
	);
}

function PlanningChat({ task, sessionId }: { task: DeepWorkTask; sessionId: string }) {
	const { data: session, isLoading } = useWorkspaceSession(sessionId, task.hostId);
	const [busy, setBusy] = useState(true);
	const [handoffOpen, setHandoffOpen] = useState(false);
	const workChanged = useCallback(({ controllerBusy, hasRunningTurn, queuedTurnCount }: {
		controllerBusy: boolean;
		hasRunningTurn: boolean;
		queuedTurnCount: number;
	}) => setBusy(controllerBusy || hasRunningTurn || queuedTurnCount > 0), []);

	return (
		<div className="flex min-h-0 flex-1 flex-col pb-14">
			<div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2">
				<h2 className="text-sm font-medium">Planning Chat</h2>
				<div className="flex gap-2">
					<DiscardTaskButton task={task} />
					<Button size="sm" variant="primary" disabled={!session || busy} onClick={() => setHandoffOpen(true)}>Hand off to worker</Button>
				</div>
			</div>
			{session ? <SessionChatSurface session={session} hostId={task.hostId} daemonReady planning onConversationWorkChange={workChanged} />
				: <p role="status" className="p-4 text-sm text-muted-foreground">{isLoading ? "Loading Planning Chat…" : "The planning session is unavailable."}</p>}
			<WorkerHandoffDialog task={task} open={handoffOpen} onOpenChange={setHandoffOpen} />
		</div>
	);
}

function WorkerHandoffDialog({ task, open, onOpenChange }: { task: DeepWorkTask; open: boolean; onOpenChange: (open: boolean) => void }) {
	const launch = useTaskLaunch({ projectId: task.projectId, hostId: task.hostId, preferChat: true, prepare: false });
	const queryClient = useQueryClient();
	const update = useDeepWorkStore((state) => state.updateTask);
	const inFlight = useRef(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const { buildRequest } = task;
	const text = task.handoff ?? "";
	const locked = Boolean(buildRequest);

	const start = async (useTerminal = false) => {
		if (inFlight.current || !text.trim() || !launch.canSubmit) return;
		inFlight.current = true;
		setBusy(true);
		setError(undefined);
		try {
			// A lost launch response is retried with the same request, so the worker is not started twice.
			const request = buildRequest ?? { requestId: crypto.randomUUID(), text, replay: { ...launch.launchSnapshot(), ...(useTerminal ? { mode: "tui" as const } : {}) } };
			if (!buildRequest && !update(task.id, { buildRequest: request })) return;
			await launch.launch(request.text, { clientRequestId: request.requestId, replay: request.replay, attachments: [] });
			// The worker owns the work now. Stopping the planner is best effort, so it never holds the task.
			await stopPlanner(task).catch(() => undefined);
			void queryClient.invalidateQueries({ queryKey: workspaceQueryKeyForHost(task.hostId) });
			useDeepWorkStore.getState().clearTask(task.id);
		} catch (cause) {
			if (!buildRequest && !sendIsUncertain(cause)) update(task.id, { buildRequest: undefined });
			setError(cause instanceof Error ? cause.message : "Try again.");
		} finally {
			inFlight.current = false;
			setBusy(false);
		}
	};

	const recovery = !locked && (launch.error ? launch.errorAction : launch.remoteLoadErrorAction);
	const recoveryInput = !locked && launch.error ? launch.errorAction?.input : undefined;
	const canStart = !busy && Boolean(text.trim()) && launch.canSubmit;
	return (
		<Dialog open={open} onOpenChange={(next) => { if (busy && !next) return; onOpenChange(next); }}>
			<DialogContent
				aria-busy={busy || undefined}
				className={cn(settingsDialogContentClass, "w-[min(520px,calc(100vw-24px))]")}
			>
				<div className={cn(settingsDialogHeaderClass, "border-b-0 p-5 pr-12")}>
					<DialogTitle className="settings-dialog-title text-base">Hand off to worker</DialogTitle>
					<DialogDescription asChild>
						<div className="text-control leading-5 text-settings-muted">A fresh worker starts with exactly this prompt. Planning Chat stops once the worker starts.</div>
					</DialogDescription>
				</div>
				<div className={cn(settingsDialogBodyClass, "px-5 pt-0 pb-3")}>
					<label className="text-sm font-medium">Handoff
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
				</div>
				<div className={cn(settingsDialogFooterClass, "gap-2 border-t-0 p-4 pt-1")}>
					<DialogClose asChild>
						<Button type="button" size="sm" variant="secondary" disabled={busy}>Cancel</Button>
					</DialogClose>
					{recovery ? <Button size="sm" variant="secondary" onClick={recovery.onClick}>{recovery.label}</Button> : null}
					{!locked && launch.fallbackAction === "tui" ? <Button size="sm" variant="secondary" disabled={!canStart} onClick={() => void start(true)}>Start in Terminal</Button> : null}
					<Button size="sm" variant="primary" disabled={!canStart} onClick={() => void start()}>
						{busy ? "Starting worker…" : "Start worker"}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
