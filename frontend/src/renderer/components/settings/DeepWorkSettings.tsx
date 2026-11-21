import { useState } from "react";
import { parseUnlockTimes, useDeepWorkStore } from "../../stores/deep-work-store";
import { useUiStore } from "../../stores/ui-store";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

export function DeepWorkSettings() {
	const { enabled, task, times, setEnabled, setTimes, storageError } = useDeepWorkStore();
	const [draft, setDraft] = useState<string>();
	const parsed = parseUnlockTimes(draft ?? times.join(", "));
	return (
		<SettingsSection title="Deep Work Mode" grouped>
			<SettingsRow label="Deep Work Mode" description={task
				? "Finish or discard the current task to turn off Deep Work Mode."
				: "Plan on Deep and review agent activity during scheduled visits to Shallow."}>
				<Switch aria-label="Deep Work Mode" checked={enabled} disabled={Boolean(task)} onCheckedChange={(next) => {
					if (setEnabled(next) && next) {
						const ui = useUiStore.getState();
						ui.clearGlobalToast();
						ui.setCommandPaletteOpen(false);
					}
				}} />
			</SettingsRow>
			{enabled ? (
				<form onSubmit={(event) => {
					event.preventDefault();
					if (parsed && setTimes(parsed)) setDraft(undefined);
				}}>
					<SettingsRow label="Daily unlocks" description="Enter local times in 24-hour HH:MM format, separated by commas or new lines.">
						<div className="flex w-56 min-w-0 items-start gap-2">
							<textarea
								aria-label="Daily unlocks"
								aria-invalid={!parsed}
								className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
								rows={2}
								value={draft ?? times.join(", ")}
								onChange={(event) => setDraft(event.target.value)}
							/>
							<Button size="sm" type="submit" disabled={draft === undefined || !parsed}>Save</Button>
						</div>
					</SettingsRow>
					{!parsed ? <p className="px-4 pb-2 text-xs text-destructive" role="alert">Use times from 00:00 to 23:59.</p> : null}
				</form>
			) : null}
			{storageError ? <p className="px-4 py-2 text-xs text-destructive" role="alert">{storageError}</p> : null}
		</SettingsSection>
	);
}
