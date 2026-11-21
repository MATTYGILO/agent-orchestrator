import { useDeepWorkStore } from "../stores/deep-work-store";
import { useUiStore } from "../stores/ui-store";

export function showDeepWorkAccessNotice(state = useDeepWorkStore.getState()) {
	const message = state.side === "shallow"
		? "Return to Deep to start a new task."
		: state.task
			? "Finish or discard the current Deep Work task before opening other work."
			: "Switch to Shallow to open sessions, activity and pull requests.";
	// Keep the notice away from the switcher, which is the next action it names.
	useUiStore.getState().showGlobalToast(message, undefined, { placement: "top-center", dedupeKey: "deep-work-access" });
}
