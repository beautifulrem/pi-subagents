import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AsyncJobStep, SubagentState } from "../shared/types.ts";

export const FLEET_STATUS_WIDGET_KEY = "subagent-fleet-status";

const MAX_AGENT_ROWS = 5;
const REFRESH_MS = 500;

type Theme = ExtensionContext["ui"]["theme"];
type FleetStatusTui = {
	terminal?: { rows?: number };
	requestRender(): void;
};
export type FleetMouseEvent = {
	action: "press" | "drag" | "release";
	button: "left" | "other";
	column: number;
	row: number;
};

/** Parse SGR mouse input used by Pi/fixed-editor mouse reporting. */
export function parseFleetMouseEvent(data: string): FleetMouseEvent | undefined {
	const match = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/.exec(data);
	if (!match) return undefined;
	const code = Number(match[1]);
	const baseButton = code & ~(4 | 8 | 16 | 32);
	return {
		button: baseButton === 0 ? "left" : "other",
		action: match[4] === "m" ? "release" : (code & 32) !== 0 ? "drag" : "press",
		column: Number(match[2]),
		row: Number(match[3]),
	};
}
type FleetStatusEntry = {
	key: string;
	agent: string;
	description?: string;
	state: string;
	startedAt: number;
	tokens: number;
};

export interface FleetStatusOptions {
	refreshMs?: number;
	maxAgentRows?: number;
}

export function formatFleetElapsed(ms: number): string {
	return `${Math.max(0, Math.round(ms / 1000))}s`;
}

export function formatFleetTokens(count: number): string {
	let compact: string;
	if (count >= 1_000_000) compact = `${(count / 1_000_000).toFixed(1)}M`;
	else if (count >= 1_000) compact = `${(count / 1_000).toFixed(1)}k`;
	else compact = `${Math.max(0, Math.round(count))}`;
	return `↓ ${compact} tokens`;
}

function rightAlign(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	const maxLeftWidth = Math.max(0, width - rightWidth - 1);
	const leftClamped = truncateToWidth(left, maxLeftWidth);
	const gap = Math.max(1, width - visibleWidth(leftClamped) - rightWidth);
	return truncateToWidth(`${leftClamped}${" ".repeat(gap)}${right}`, width);
}

function isActiveState(value: string): boolean {
	return value === "running" || value === "queued" || value === "pending";
}

export function collectFleetStatusEntries(state: SubagentState): FleetStatusEntry[] {
	const entries: FleetStatusEntry[] = [];
	for (const control of state.foregroundControls.values()) {
		if (control.activeChildren) {
			for (const child of [...control.activeChildren.values()].sort((left, right) => left.index - right.index)) {
				entries.push({
					key: `foreground-active:${control.runId}:${child.index}`,
					agent: child.agent,
					description: child.description,
					state: "running",
					startedAt: child.startedAt,
					tokens: child.tokens ?? 0,
				});
			}
			continue;
		}
		entries.push({
			key: `foreground-active:${control.runId}:${control.currentIndex ?? 0}`,
			agent: control.currentAgent ?? control.mode,
			description: control.description,
			state: "running",
			startedAt: control.startedAt,
			tokens: control.tokens ?? 0,
		});
	}

	for (const job of state.asyncJobs.values()) {
		if (!isActiveState(job.status)) continue;
		const startedAt = job.startedAt ?? job.updatedAt ?? Date.now();
		const steps: AsyncJobStep[] | undefined = job.steps?.length
			? job.steps
			: job.agents?.map((agent, index) => {
				const pending = job.status === "queued"
					|| (job.mode === "chain" && !job.activeParallelGroup && index !== (job.currentStep ?? 0));
				return { agent, index, status: pending ? "pending" : "running" };
			});
		if (!steps?.length) {
			entries.push({
				key: `async:${job.asyncId}`,
				agent: job.mode ?? "subagent",
				description: job.description,
				state: job.status,
				startedAt,
				tokens: job.totalTokens?.total ?? 0,
			});
			continue;
		}
		for (const [offset, step] of steps.entries()) {
			if (!isActiveState(step.status)) continue;
			const index = step.index ?? offset;
			if (step.status === "pending" && job.mode === "chain" && !job.activeParallelGroup && index !== (job.currentStep ?? 0)) continue;
			entries.push({
				key: `async:${job.asyncId}:${index}`,
				agent: step.label ? `${step.label} (${step.agent})` : step.agent,
				description: job.description,
				state: step.status,
				startedAt: step.startedAt ?? startedAt,
				tokens: step.tokens?.total ?? (steps.length === 1 ? job.totalTokens?.total ?? 0 : 0),
			});
		}
	}

	return entries.sort((left, right) => left.startedAt - right.startedAt || left.key.localeCompare(right.key));
}

export class SubagentFleetStatus {
	private ctx: ExtensionContext | undefined;
	private tui: FleetStatusTui | undefined;
	private inputUnsubscribe: (() => void) | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private widgetRegistered = false;
	private inspectorOpen = false;
	private lastRenderKey = "";
	private entries: FleetStatusEntry[] = [];
	private clickableRows = new Map<number, string>();
	private renderedLineCount = 0;
	private renderedWidth = 0;
	private screenRows = 0;
	private readonly state: SubagentState;
	private readonly openInspector: (itemKey: string) => Promise<void> | void;
	private readonly refreshMs: number;
	private readonly maxAgentRows: number;

	constructor(
		state: SubagentState,
		openInspector: (itemKey: string) => Promise<void> | void,
		options: FleetStatusOptions = {},
	) {
		this.state = state;
		this.openInspector = openInspector;
		this.refreshMs = options.refreshMs ?? REFRESH_MS;
		this.maxAgentRows = options.maxAgentRows ?? MAX_AGENT_ROWS;
	}

	setContext(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (this.ctx?.ui === ctx.ui) {
			this.ctx = ctx;
			this.refresh();
			return;
		}
		this.clearUiRegistration();
		this.ctx = ctx;
		if (typeof ctx.ui.onTerminalInput === "function") {
			this.inputUnsubscribe = ctx.ui.onTerminalInput((data) => this.handleKey(data));
		}
		this.timer = setInterval(() => this.refresh(), this.refreshMs);
		this.timer.unref?.();
		this.refresh();
	}

	dispose(): void {
		this.clearUiRegistration();
		this.ctx = undefined;
		this.entries = [];
		this.inspectorOpen = false;
		this.lastRenderKey = "";
		this.clickableRows.clear();
		this.renderedLineCount = 0;
		this.renderedWidth = 0;
		this.screenRows = 0;
	}

	refresh(): void {
		const ctx = this.ctx;
		if (!ctx?.hasUI) return;
		this.entries = collectFleetStatusEntries(this.state);
		if (this.inspectorOpen || this.state.fleetInspectorOpen) {
			this.lastRenderKey = "";
			if (this.widgetRegistered) {
				ctx.ui.setWidget(FLEET_STATUS_WIDGET_KEY, undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			return;
		}
		if (this.entries.length === 0) {
			this.lastRenderKey = "";
			if (this.widgetRegistered) {
				ctx.ui.setWidget(FLEET_STATUS_WIDGET_KEY, undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			return;
		}

		const renderKey = this.getRenderKey();
		if (!this.widgetRegistered) {
			ctx.ui.setWidget(FLEET_STATUS_WIDGET_KEY, (tui, theme) => {
				this.tui = tui;
				return {
					render: (width: number) => this.render(width, theme),
					invalidate: () => {
						this.lastRenderKey = "";
					},
					dispose: () => {
						if (this.tui !== tui) return;
						this.widgetRegistered = false;
						this.tui = undefined;
					},
				};
			}, { placement: "belowEditor" });
			this.widgetRegistered = true;
			this.lastRenderKey = renderKey;
			return;
		}
		if (renderKey === this.lastRenderKey) return;
		this.lastRenderKey = renderKey;
		this.tui?.requestRender();
	}

	handleKey(data: string): { consume?: boolean; data?: string } | undefined {
		if (!this.ctx?.hasUI || this.entries.length === 0 || this.inspectorOpen || isKeyRelease(data)) return undefined;
		const mouse = parseFleetMouseEvent(data);
		return mouse ? this.handleMouse(mouse) : undefined;
	}

	render(width: number, theme: Theme): string[] {
		if (this.entries.length === 0) return [];
		const lines = [truncateToWidth(`  ${theme.fg("dim", "Subagents · click a row to inspect · Ctrl+Alt+F opens fleet")}`, width), ""];
		const rowKeys: Array<string | undefined> = [undefined, undefined];
		const visibleCount = Math.min(this.maxAgentRows, this.entries.length);
		for (let index = 0; index < visibleCount; index++) {
			lines.push(this.renderEntry(this.entries[index]!, width, theme));
			rowKeys.push(this.entries[index]!.key);
		}
		const hiddenBelow = this.entries.length - visibleCount;
		if (hiddenBelow > 0) {
			lines.push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), width));
			rowKeys.push(undefined);
		}
		// Visible-width space survives fixed-editor's trailing-empty trim and creates one gap.
		lines.push(" ");
		rowKeys.push(undefined);
		this.clickableRows.clear();
		rowKeys.forEach((key, row) => { if (key) this.clickableRows.set(row, key); });
		this.renderedLineCount = lines.length;
		this.renderedWidth = width;
		const rows = this.tui?.terminal?.rows;
		if (typeof rows === "number" && Number.isFinite(rows)) this.screenRows = rows;
		return lines;
	}

	private renderEntry(entry: FleetStatusEntry, width: number, theme: Theme): string {
		const description = entry.description?.replace(/\s+/g, " ").trim();
		const glyph = entry.state === "running" ? theme.fg("accent", "●") : theme.fg("muted", "◦");
		const left = `  ${glyph} ${theme.fg("muted", entry.agent)}${description ? `  ${description}` : ""}`;
		const elapsed = Date.now() - entry.startedAt;
		const right = theme.fg("dim", `${formatFleetElapsed(elapsed)} · ${formatFleetTokens(entry.tokens)}`);
		return rightAlign(left, right, width);
	}

	private openItem(itemKey: string): void {
		const ctx = this.ctx;
		if (!ctx?.hasUI) return;
		this.inspectorOpen = true;
		this.refresh();
		void Promise.resolve()
			.then(() => this.openInspector(itemKey))
			.catch((error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"))
			.finally(() => {
				this.inspectorOpen = false;
				this.refresh();
			});
	}

	private handleMouse(mouse: FleetMouseEvent): { consume?: boolean } | undefined {
		if (mouse.button !== "left" || mouse.action !== "press" || mouse.column < 1 || mouse.column > this.renderedWidth) return undefined;
		const widgetStartRow = this.screenRows - this.renderedLineCount; // one footer row below
		const key = this.clickableRows.get(mouse.row - widgetStartRow);
		if (!key) return undefined;
		this.openItem(key);
		return { consume: true };
	}

	private getRenderKey(): string {
		const now = Date.now();
		return JSON.stringify({
			inspectorOpen: this.inspectorOpen,
			entries: this.entries.map((entry) => [
				entry.key,
				entry.agent,
				entry.description,
				entry.state,
				Math.round((now - entry.startedAt) / 1000),
				entry.tokens,
			]),
		});
	}

	private clearUiRegistration(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.inputUnsubscribe?.();
		this.inputUnsubscribe = undefined;
		if (this.ctx?.hasUI && this.widgetRegistered) {
			try {
				this.ctx.ui.setWidget(FLEET_STATUS_WIDGET_KEY, undefined);
			} catch {
				// The previous extension context may already be stale during reload/session replacement.
			}
		}
		this.widgetRegistered = false;
		this.tui = undefined;
	}
}
