import { lazy, Suspense } from "react";
import { useDeepWorkStore } from "../stores/deep-work-store";
import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "../components/HomePage";
import { MigrationPopup } from "../components/MigrationPopup";

const SessionsBoard = lazy(() => import("../components/SessionsBoard").then(({ SessionsBoard }) => ({ default: SessionsBoard })));

export const Route = createFileRoute("/_shell/")({
	component: ShellIndex,
});

function ShellIndex() {
	const shallow = useDeepWorkStore((state) => state.enabled && state.side === "shallow");
	if (shallow) return <Suspense fallback={null}><SessionsBoard /></Suspense>;
	return (
		<>
			<MigrationPopup />
			<HomePage />
		</>
	);
}
