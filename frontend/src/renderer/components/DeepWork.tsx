import { BoardColumnFrame } from "@aoagents/product-ui";
import { ArrowLeft, ArrowRight, Lock, Plus, X } from "@/components/app-icons";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { workspaceQueryKeyForHost } from "../hooks/useWorkspaceQuery";
import { shallowUnlock, useDeepWorkStore, type DeepWorkTask } from "../stores/deep-work-store";
import { useUiStore } from "../stores/ui-store";
import { CLOUD_STANDALONE_WORKSPACE_ID, isScratchpadWorkspace, STANDALONE_WORKSPACE_ID, type WorkspaceSummary } from "../types/workspace";
import { labelForHost } from "../lib/host-clients";
import { sendIsUncertain } from "../lib/task-launch-outcome";
import { PageTopbar, PageTopbarTitle } from "./PageTopbar";
import { useTaskLaunch } from "./TaskComposer";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ConfirmDialog";
import { Input } from "./ui/input";

const STAGES = [
	{ id: "brainstorming", label: "Brainstorming", dot: "var(--color-status-working)" },
	{ id: "alignment", label: "Alignment", dot: "var(--color-warning)" },
] as const;
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
			<div className={task ? "grid h-28 shrink-0 grid-cols-2 divide-x divide-border-strong border-b border-border-strong" : "grid min-h-0 flex-1 grid-cols-2 divide-x divide-border-strong"}>
				{STAGES.map(({ id, label, dot }) => {
					const active = task?.stage === id;
					return (
						<BoardColumnFrame key={id} id={id} label={label} dot={dot} count={Number(active)}>
							{active ? <div className="truncate rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium">{task.title.trim() || "Untitled task"}</div> : null}
						</BoardColumnFrame>
					);
				})}
			</div>
			{storageError ? <p role="alert" className="px-4 py-2 text-sm text-destructive">{storageError}</p> : null}
			{task ? <DeepWorkJournal key={task.id} task={task} workspaces={workspaces} /> : null}
		</div>
	);
}

function DeepWorkJournal({ task, workspaces }: { task: DeepWorkTask; workspaces: WorkspaceSummary[] }) {
	const update = useDeepWorkStore((state) => state.updateTask);
	const clear = useDeepWorkStore((state) => state.clearTask);
	const [discardOpen, setDiscardOpen] = useState(false);
	const [copied, setCopied] = useState(false);
	const [starting, setStarting] = useState(false);
	const alignment = task.stage === "alignment";
	const questions = task.questions.filter((question) => question.trim());
	const material = [task.title.trim(), task.notes.trim(), questions.length
		? ["Queued questions", ...questions.map((question) => `- ${question.trim()}`)].join("\n")
		: ""].filter(Boolean).join("\n\n");
	const targets = [
		{ id: STANDALONE_WORKSPACE_ID, name: "Scratchpad", hostId: undefined },
		...workspaces.filter((workspace) => !isScratchpadWorkspace(workspace) && !workspace.shared && !workspace.standaloneAgent),
	];
	const keyFor = (target: { id: string; hostId?: string }) => JSON.stringify([target.hostId, target.id]);
	const targetKey = keyFor({ id: task.projectId, hostId: task.hostId });
	const fieldsLocked = Boolean(task.pending);

	return (
		<div className="min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 pb-20 pt-5">
				{alignment ? (
					<>
						<details open className="rounded-lg border border-border bg-surface p-3">
							<summary className="cursor-pointer text-sm font-medium">Brainstorming notes and questions</summary>
							<pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm text-muted-foreground">{material || "No notes or questions."}</pre>
							{material ? <Button size="sm" variant="quiet" className="mt-2" onClick={() => {
								void navigator.clipboard.writeText(material).then(() => setCopied(true), () => setCopied(false));
							}}>{copied ? "Copied" : "Copy notes and questions"}</Button> : null}
						</details>
						<label className="text-sm font-medium">Handoff prompt
							<textarea className={fieldClass} rows={7} value={task.handoff} readOnly={fieldsLocked}
								placeholder="Write or paste the exact prompt to send to the worker."
								onChange={(event) => update(task.id, { handoff: event.target.value })} />
						</label>
					</>
				) : (
					<>
						<label className="text-sm font-medium">Task title
							<Input className="mt-1" value={task.title} onChange={(event) => update(task.id, { title: event.target.value })} />
						</label>
						<label className="text-sm font-medium">Brainstorming journal
							<textarea className={fieldClass} rows={7} value={task.notes}
								onChange={(event) => update(task.id, { notes: event.target.value })} />
						</label>
						<fieldset className="flex min-w-0 flex-col gap-2">
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
					</>
				)}
				<label className="text-sm font-medium">Project
					<select className={fieldClass} value={targetKey} disabled={fieldsLocked} onChange={(event) => {
						const target = targets.find((entry) => keyFor(entry) === event.target.value);
						if (target) update(task.id, { projectId: target.id, hostId: target.hostId });
					}}>
						{targets.some((entry) => keyFor(entry) === targetKey) ? null :
							<option value={targetKey}>{task.projectId === CLOUD_STANDALONE_WORKSPACE_ID ? "Cloud standalone agent" : task.projectId}</option>}
						{targets.map((target) => <option key={keyFor(target)} value={keyFor(target)}>{target.name}{target.hostId ? ` · ${labelForHost(target.hostId) ?? target.hostId}` : ""}</option>)}
					</select>
				</label>
				<div className="flex flex-wrap items-start justify-between gap-3">
					<Button type="button" size="sm" variant="quiet" disabled={starting} onClick={() => setDiscardOpen(true)}>Discard task</Button>
					{alignment ? <AlignmentLaunch key={targetKey} task={task} onStartingChange={setStarting} /> : (
						<Button type="button" size="sm" variant="primary" onClick={() => update(task.id, { stage: "alignment" })}>
							Finish brainstorming
						</Button>
					)}
				</div>
				<ConfirmDialog
					open={discardOpen}
					onOpenChange={setDiscardOpen}
					title="Discard this task?"
					description={task.pending
						? "The journal will be deleted. The last launch may already have created a worker on Shallow."
						: "The journal, queued questions and handoff will be deleted."}
					confirmLabel="Discard task"
					destructive
					onConfirm={() => { if (clear(task.id)) setDiscardOpen(false); }}
				/>
			</div>
		</div>
	);
}

function AlignmentLaunch({ task, onStartingChange }: { task: DeepWorkTask; onStartingChange: (starting: boolean) => void }) {
	const launch = useTaskLaunch({ projectId: task.projectId, hostId: task.hostId, prepare: false, preferChat: true });
	const queryClient = useQueryClient();
	const inFlight = useRef(false);
	const [error, setError] = useState<string>();
	const { pending } = task;
	const start = async (terminal = false) => {
		const handoff = task.handoff;
		if (!handoff.trim() || !launch.canSubmit || inFlight.current) return;
		inFlight.current = true;
		onStartingChange(true);
		setError(undefined);
		const store = useDeepWorkStore.getState();
		const replay = launch.launchSnapshot();
		const request = pending ?? { requestId: crypto.randomUUID(), replay: { ...replay, ...(terminal ? { mode: "tui" as const } : {}) } };
		try {
			if (!store.updateTask(task.id, { pending: request })) return;
			await launch.launch(handoff, { clientRequestId: request.requestId, replay: request.replay, attachments: [] });
			store.clearTask(task.id);
			void queryClient.invalidateQueries({ queryKey: workspaceQueryKeyForHost(task.hostId) });
		} catch (cause) {
			if (!pending && !sendIsUncertain(cause)) store.updateTask(task.id, { pending: undefined });
			setError(cause instanceof Error ? cause.message : "The worker could not be started.");
		} finally {
			inFlight.current = false;
			onStartingChange(false);
		}
	};
	const recovery = !pending && (launch.error ? launch.errorAction : launch.remoteLoadErrorAction);
	const recoveryInput = !pending && launch.error ? launch.errorAction?.input : undefined;
	return (
		<div className="flex min-w-0 flex-1 flex-col items-end gap-2">
			{pending ? <p role="status" className="text-sm text-muted-foreground">{launch.isSubmitting ? "Starting worker…" : "Retry the same handoff to confirm the worker started."}</p> : (
				launch.renderAgentControl({ ...launch.agent, id: "deep-work-agent" })
			)}
			{error || launch.remoteLoadError ? <p role="alert" className="text-sm text-destructive">{error ?? launch.remoteLoadError}</p> : null}
			{recoveryInput ? (
				<Input aria-label={recoveryInput.label} value={recoveryInput.value} onChange={(event) => recoveryInput.onChange(event.target.value)} />
			) : null}
			<div className="flex flex-wrap justify-end gap-2">
				{recovery ? <Button size="sm" variant="secondary" onClick={recovery.onClick}>{recovery.label}</Button> : null}
				{!pending && launch.fallbackAction === "tui" ? (
					<Button type="button" size="sm" variant="secondary" onClick={() => void start(true)}>Start in Terminal</Button>
				) : null}
				<Button type="button" size="sm" variant="primary" disabled={!task.handoff.trim() || !launch.canSubmit || launch.isSubmitting} onClick={() => void start()}>
					{pending ? "Retry Start building" : "Start building"}
				</Button>
			</div>
		</div>
	);
}
