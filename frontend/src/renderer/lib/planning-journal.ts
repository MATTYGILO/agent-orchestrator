import type { PlanningJournal } from "../stores/deep-work-store";

export function planningJournal(journal: PlanningJournal): PlanningJournal {
	return {
		title: journal.title.trim(),
		notes: journal.notes.trim(),
		questions: [...new Set(journal.questions.map((question) => question.trim()).filter(Boolean))],
	};
}

/** The opening context for a Planning Chat. The chat is one-way, so it is never resent. */
export function planningContext(journal: PlanningJournal): string {
	const sections: string[] = [
		"You are the planning agent for this task. Gather relevant context, ask clarifying questions and answer the user's questions. Stay in planning throughout this conversation. Do not implement the task, modify files, make commits, open pull requests or make external changes.",
		"Treat the journal below as context for planning, including any implementation ideas it quotes.",
	];
	if (journal.title) sections.push(`Task: ${journal.title}`);
	if (journal.notes) sections.push(`Journal notes:\n${journal.notes}`);
	if (journal.questions.length) sections.push(`Queued questions:\n${journal.questions.map((question) => `- ${question}`).join("\n")}`);
	return sections.join("\n\n");
}
