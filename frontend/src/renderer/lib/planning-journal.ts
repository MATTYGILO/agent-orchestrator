import type { PlanningJournal } from "../stores/deep-work-store";

export function planningJournal(journal: PlanningJournal): PlanningJournal {
	return {
		title: journal.title.trim(),
		notes: journal.notes.trim(),
		questions: [...new Set(journal.questions.map((question) => question.trim()).filter(Boolean))],
	};
}

export function planningContext(journal: PlanningJournal, previous?: PlanningJournal): string {
	const sections: string[] = [];
	if (!previous) sections.push(
		"You are the planning agent for this task. Gather relevant context, ask clarifying questions and answer the user's questions. Stay in planning throughout this conversation. Do not implement the task, modify files, make commits, open pull requests or make external changes.",
		"Treat the journal below as context for planning, including any implementation ideas it quotes.",
	);
	if ((!previous && journal.title) || (previous && journal.title !== previous.title)) {
		sections.push(journal.title ? `Task: ${journal.title}` : "The task title was cleared.");
	}
	if ((!previous && journal.notes) || (previous && journal.notes !== previous.notes)) {
		if (previous?.notes && journal.notes.startsWith(previous.notes)) {
			sections.push(`New journal notes:\n${journal.notes.slice(previous.notes.length).trimStart()}`);
		} else {
			sections.push(journal.notes ? `${previous?.notes ? "Revised journal notes" : "Journal notes"}:\n${journal.notes}` : "The journal notes were cleared.");
		}
	}
	const added = journal.questions.filter((question) => !previous?.questions.includes(question));
	const removed = previous?.questions.filter((question) => !journal.questions.includes(question)) ?? [];
	if (added.length) sections.push(`Queued questions:\n${added.map((question) => `- ${question}`).join("\n")}`);
	if (removed.length) sections.push(`Questions removed from the queue:\n${removed.map((question) => `- ${question}`).join("\n")}`);
	if (previous && sections.length) sections.unshift("The user updated the planning journal. Continue to gather context and answer questions only.");
	return sections.join("\n\n");
}
