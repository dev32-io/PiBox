import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderDeliveryHistory } from "../assets/app.js";
import { projectTaskCard } from "../projector.js";

const appPath = new URL("../assets/app.js", import.meta.url);
const stylesPath = new URL("../assets/styles.css", import.meta.url);

test("task board keeps exactly three semantic columns and preserves projected status text", async () => {
	const app = await readFile(appPath, "utf8");
	assert.match(app, /const COLUMNS = \["To do", "In progress", "Done"\]/);
	assert.doesNotMatch(app.slice(app.indexOf("function board"), app.indexOf("function documents")), /workflowStage|stage\.integration|stage\.verification/);
	const tasks = [projectTaskCard({ id: "one", status: "ready" }), projectTaskCard({ id: "two", status: "running" }), projectTaskCard({ id: "three", status: "integrated" })];
	assert.deepEqual(tasks.map((task) => task.column), ["To do", "In progress", "Done"]);
	assert.deepEqual(tasks.map((task) => task.status), ["ready", "running", "integrated"]);
	assert.equal(new Set(tasks.map((task) => task.id)).size, tasks.length);
});

test("task delivery history renders only allowlisted projected fields", () => {
	const rendered = renderDeliveryHistory({ executionMode: "worktree", completedCommit: "abcdef1234567890", mergedCommit: "fedcba0987654321", worktree: "/private/worktree", lastRunId: "private-run-id", nested: { secret: true } });
	assert.match(rendered, /Execution mode/); assert.match(rendered, /abcdef1234567890/); assert.match(rendered, /fedcba0987654321/);
	assert.doesNotMatch(rendered, /private\/worktree|private-run-id|lastRunId|nested|secret|JSON\.stringify/);
});

test("workflow markup makes execution primary with compact modes, tasks, and phase gates", async () => {
	const app = await readFile(appPath, "utf8");
	assert.match(app, /class="workflow-pipeline"/);
	assert.match(app, /<ol class="stage-task-list/);
	assert.match(app, /sequential-chain/);
	assert.match(app, /parallel-list/);
	assert.match(app, /mode-\$\{mode\}/);
	assert.match(app, /Sequential · \$\{tasks\.length\} ordered tasks/);
	assert.match(app, /Concurrent · \$\{tasks\.length\} workstreams/);
	assert.match(app, /Execution mode unknown/);
	assert.match(app, /dashboardIcon\(mode\)/);
	assert.match(app, /dashboardIcon\("join"\)/);
	assert.doesNotMatch(app, /⑂|⇣|⌄/);
	assert.match(app, /gate\("Implementation"[\s\S]*gate\("Integration"[\s\S]*gate\("Verification"[\s\S]*gate\("Review"/);
	for (const phase of ["implementation", "integration", "verification", "review", "e2e", "outcome"]) assert.match(app, new RegExp(`${phase}:`));
	assert.match(app, /class="gate-icon"[\s\S]*dashboardIcon\(iconKind\)/);
	assert.match(app, /Whole-branch review/);
	assert.match(app, /Final E2E/);
	assert.doesNotMatch(app, /data-filter=|ACTIVE_TASK_STATUSES|taskNeedsAttention/);
	assert.doesNotMatch(app, /data-density=|collapse-completed|Workflow display controls|Stages expand and collapse independently/);

	const taskMarkup = app.slice(app.indexOf("function workflowTask"), app.indexOf("function gateDetails"));
	assert.match(taskMarkup, /task-primary-row/); assert.match(taskMarkup, /task-metadata-row/); assert.match(taskMarkup, /task-marker/); assert.match(taskMarkup, /task-status-text/);
	assert.match(app, /task-tag task-checks/); assert.match(taskMarkup, /task-dependency-tag/); assert.match(taskMarkup, /task-repair-tag/);
	assert.match(taskMarkup, /dependencies\.length \|\| wait \?/); assert.match(taskMarkup, /repairs \?/);
	assert.doesNotMatch(taskMarkup, /task-check-summary|execution-label|task-sequence|Parallel workstream|Sequential step|P\$\{|dependsOn\.map\(escapeHtml\)|summaryLine\("Result"/);
	for (const signal of ["task.status", "task.title", "task.id", "taskChecks(task)", "repairCount", "incompleteDependencyCount", "task?.failure"]) assert.match(app, new RegExp(signal.replace(/[?.()]/g, "\\$&")));

	assert.match(app, /class="progress-orbit\$\{percent === 100 \? " is-complete" : ""\}"/);
	assert.match(app, /metricCard/); assert.doesNotMatch(app, /orbit-dot/);
	const workflowView = app.slice(app.indexOf("function workflowView"), app.indexOf("function board"));
	const orderedCalls = ["workflowHero(workspace)", "workflowMetrics(workspace)", "workflow-pipeline-section", "endCap(workspace)", "workflowTiming(workspace)"].map((value) => workflowView.indexOf(value));
	assert.ok(orderedCalls.every((position) => position >= 0));
	assert.deepEqual(orderedCalls, [...orderedCalls].sort((left, right) => left - right), "execution and assurance precede activity timing");
	assert.match(app, /class="timing-bar"/); assert.match(app, /data-tooltip=/);
	assert.match(app, /class="timing-\$\{category\}" tabindex="0"/); assert.doesNotMatch(app, /class="timing-segment[^`]*tabindex/);
});

test("stage timing truthfully says interrupted intervals were excluded", async () => {
	const app = await readFile(appPath, "utf8");
	assert.match(app, /\$\{number\(timing\.incompleteIntervals\)\} interrupted timing \$\{number\(timing\.incompleteIntervals\) === 1 \? "interval was" : "intervals were"\} excluded\./);
	assert.doesNotMatch(app, /Includes .*incomplete timing/);
});

test("stage disclosure uses a native focused button with collapsed operational summary and motion fallback", async () => {
	const [app, styles] = await Promise.all([readFile(appPath, "utf8"), readFile(stylesPath, "utf8")]);
	const stageMarkup = app.slice(app.indexOf("function workflowStage"), app.indexOf("function dashboardIcon"));
	assert.match(stageMarkup, /<h3 id="\$\{escapeHtml\(headingId\)\}" class="sr-only"/);
	assert.match(stageMarkup, /<button type="button" class="stage-header stage-disclosure" data-stage-disclosure=/);
	assert.match(stageMarkup, /aria-expanded="\$\{expanded\}" aria-controls=/);
	assert.doesNotMatch(stageMarkup, /role="button"|tabindex="0"/);
	assert.match(stageMarkup, /class="stage-mode-label"[\s\S]*dashboardIcon\(mode\)[\s\S]*Stage \$\{index \+ 1\} · \$\{modeName\}/);
	assert.match(app, /<svg class="dashboard-icon[^`]*stroke="currentColor"/, "mode icons inherit the header cue color");
	assert.match(stageMarkup, /const modeName = mode === "concurrent" \? "Concurrent" : mode === "sequential" \? "Sequential" : "Unknown"/);
	assert.match(stageMarkup, /const stageIdLabel = title === stage\.id \? "" : `<code>/, "duplicate visible stage IDs are omitted");
	assert.match(stageMarkup, /const exceptionSummary = exceptions \? `<span>/, "zero-exception summaries are omitted");
	const disclosureLabel = app.slice(app.indexOf("function stageDisclosureLabel"), app.indexOf("function workflowStage"));
	for (const field of [/Collapse/, /Expand/, /\$\{title\}/, /\$\{modeName\} mode/, /Status: \$\{titleCase\(status \|\| "pending"\)\}/, /\$\{completed\} of \$\{total\} tasks complete/]) assert.match(disclosureLabel, field);
	assert.match(disclosureLabel, /timing \? `Duration: \$\{duration\(timingMilliseconds\(timing\)\)\}` : ""/);
	assert.match(disclosureLabel, /exceptions \? `\$\{exceptions\} \$\{exceptions === 1 \? "exception" : "exceptions"\}` : ""/, "zero exceptions stay out of the accessible name");
	assert.match(stageMarkup, /aria-label="\$\{escapeHtml\(disclosureLabel\)\}"/);
	assert.match(app, /target\.setAttribute\("aria-label", label\)/, "the complete accessible name survives disclosure toggles");
	assert.match(stageMarkup, /class="stage-collapsed-summary"/);
	assert.match(stageMarkup, /\$\{completed\}\/\$\{total\} complete/);
	assert.match(stageMarkup, /timingValue\(stage\.timing\)/);
	assert.match(stageMarkup, /\$\{exceptionSummary\}/);
	assert.match(stageMarkup, /dashboardIcon\("chevron"\)/);
	assert.match(app, /"data-stage-disclosure"/);
	assert.match(app, /target\.focus\(\{ preventScroll: true \}\)/);
	assert.match(app, /prefers-reduced-motion: reduce/); assert.match(app, /details\.animate/);
	assert.match(app, /\{ duration: 180, easing:/); assert.doesNotMatch(app, /duration: 220/);
	assert.doesNotMatch(app, /event\.key === "Enter" \|\| event\.key === " "/);
	assert.match(app, /role="progressbar"/); assert.match(app, /aria-valuemin="0"/);
	assert.match(app, /aria-label="Workflow time distributed/);
	assert.match(styles, /min-height: 44px/);
	assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
	assert.match(styles, /@media \(prefers-contrast: more\)/);
	assert.match(styles, /@media \(max-width: 620px\)/);
	assert.doesNotMatch(styles, /overflow-x:\s*auto/);
	assert.match(styles, /\.workflow-view\s*\{[\s\S]*--workflow-color-implementation:\s*var\(--color-accent\);[\s\S]*--workflow-color-integration:\s*var\(--color-data-violet\);[\s\S]*--workflow-color-verification:\s*var\(--color-warning\);[\s\S]*--workflow-color-review:\s*var\(--color-success\);[\s\S]*--workflow-color-e2e:\s*var\(--color-info\);/);
	assert.match(styles, /\.timing-segment \+ \.timing-segment\s*\{[^}]*border-left:\s*2px solid var\(--color-canvas\)/s);
	assert.doesNotMatch(styles, /var\(--color-navy-well\)/);
	assert.match(styles, /\.progress-orbit\.is-complete\s*\{\s*background:\s*var\(--color-accent\)/);
	for (const selector of ["workflow-hero", "pipeline-stage", "workflow-task", "workflow-gate", "workflow-endcap"]) {
		assert.match(styles, new RegExp(`\\.${selector}\\s*\\{[^}]*border:\\s*1px solid var\\(--color-border-subtle\\)`, "s"), `${selector} keeps a quiet routine boundary`);
	}
	assert.match(styles, /\.tone-border-success\s*\{[^}]*var\(--color-success\) 10%, var\(--color-border-subtle\)/s, "completed task and gate outlines stay quiet");
	assert.match(styles, /\.workflow-task:hover\s*\{[^}]*border-color:\s*var\(--color-border-strong\)/s);
	assert.match(styles, /\.workflow-task:focus-within\s*\{[^}]*border-color:\s*var\(--color-accent\)/s);

	assert.match(styles, /\.pipeline-stage\s*\{[^}]*width:\s*100%/s);
	assert.match(styles, /\.pipeline-stage::before, \.pipeline-stage::after\s*\{\s*content:\s*none/);
	assert.doesNotMatch(styles, /\.workflow-pipeline::(?:before|after)/, "stages have no inter-card chain connectors");
	assert.doesNotMatch(styles, /\.pipeline-stage\s*\{[^}]*(?:margin-left|margin):/s);
	assert.match(styles, /\.stage-number\s*\{[^}]*border-radius:\s*var\(--radius-sm\)/s);
	assert.match(styles, /\.stage-chevron\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent/s);
	assert.match(styles, /\.pipeline-stage\.mode-sequential\s*\{\s*border-left:\s*3px solid var\(--color-accent\);\s*\}/s, "the sequential stage owns one coral mode edge");
	assert.match(styles, /\.pipeline-stage\.mode-concurrent\s*\{\s*border-left:\s*3px solid var\(--color-concurrent\);\s*\}/s, "the concurrent stage owns one lavender mode edge");
	assert.match(styles, /\.pipeline-stage\.mode-unknown\s*\{\s*border-left:\s*2px dashed var\(--color-border-strong\);\s*\}/s, "the unknown stage owns one neutral dashed mode edge");
	assert.match(styles, /\.pipeline-stage\.mode-sequential \.stage-header\s*\{[^}]*var\(--color-accent-soft\)/s);
	assert.match(styles, /\.pipeline-stage\.mode-concurrent \.stage-header\s*\{[^}]*var\(--color-concurrent-soft\)/s);
	assert.match(styles, /\.stage-work\.mode-concurrent\s*\{[^}]*var\(--color-concurrent-soft\)/s);
	assert.doesNotMatch(styles, /\.pipeline-stage\.mode-(?:sequential|concurrent|unknown) \.stage-header\s*\{[^}]*border-(?:left|inline)/s, "mode headers add no second edge");
	assert.doesNotMatch(styles, /\.stage-work\.mode-(?:sequential|concurrent|unknown)\s*\{[^}]*border-(?:left|inline)/s, "mode work containers add no second edge");
	assert.match(styles, /\.stage-work\s*\{[^}]*border:\s*1px solid var\(--color-border-subtle\)/s, "stage work keeps only its ordinary subtle container border");

	assert.match(styles, /\.stage-task-list:has\(> \.workflow-task\)::before\s*\{[^}]*top:\s*calc\(-1 \* var\(--space-3\)\)[^}]*height:\s*calc\(var\(--space-3\) \+ var\(--task-node-center\)\)/s, "a short list lead reaches the first node");
	assert.match(styles, /\.sequential-chain\s*\{\s*counter-reset:\s*task-order/);
	assert.match(styles, /\.parallel-list:has\(> \.workflow-task\)::before\s*\{[^}]*width:\s*3px[^}]*background:\s*var\(--color-concurrent\)/s);
	assert.match(styles, /\.workflow-task:not\(:last-child\) > button:first-child::before\s*\{[^}]*top:\s*calc\(var\(--task-node-center\) - 1px\)[^}]*left:\s*-22px[^}]*height:\s*calc\(100% \+ var\(--task-row-gap\) \+ 2px\)/s, "each non-last row accounts for card borders and connects its node center exactly to the next row despite wrapping");
	assert.match(styles, /\.is-concurrent-task:not\(:last-child\) > button:first-child::before\s*\{[^}]*width:\s*3px[^}]*background:\s*var\(--color-concurrent\)/s);
	assert.doesNotMatch(styles, /border-inline\s*:/, "concurrency never draws paired inline borders");
	assert.doesNotMatch(styles, /\.(?:pipeline-stage|stage-work)\.mode-concurrent[^}]*box-shadow:\s*[^;}]*inset/s, "concurrency never duplicates its left edge with inset shadows");
	assert.doesNotMatch(styles, /\.(?:parallel-list|is-concurrent-task)[^{]*\{[^}]*(?:width|border(?:-left|-right|-inline)?-width):\s*7px/s, "concurrency never uses a double-width rail");
	assert.doesNotMatch(styles, /\.workflow-task:last-child[^}]*::before/, "the last row has no outgoing segment");
	assert.match(styles, /\.task-primary-row\s*\{[^}]*grid-template-columns:/s);
	assert.match(styles, /\.task-metadata-row\s*\{[^}]*flex-wrap:\s*wrap/s);
	assert.match(styles, /\.task-tag\s*\{[^}]*min-height:\s*24px/s);
	for (const [tone, token] of [["success", "success"], ["warning", "warning"], ["danger", "danger"], ["active", "accent-hover"]]) {
		assert.match(styles, new RegExp(`\\.task-status-text\\.tone-${tone} \\{ color: var\\(--color-${token}\\); \\}`));
	}
	assert.match(styles, /@media \(max-width: 620px\)[\s\S]*\.workflow-timing \.timing-legend, \.stage-timing \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}[\s\S]*\.gate-footer > ol, \.workflow-endcap > ol \{ grid-template-columns: 1fr; \}/);
	assert.match(styles, /@media \(max-width: 340px\) \{\s*\.metric-strip, \.stage-timing \{ grid-template-columns: 1fr; \}\s*\}/);
	const mobile390 = styles.slice(styles.indexOf("@media (max-width: 420px)"), styles.indexOf("@media (max-width: 340px)"));
	assert.doesNotMatch(mobile390, /\.metric-strip|\.stage-timing/, "390px retains two-column workflow metrics and stage timing");
	assert.match(styles, /\.workflow-gate\s*\{[^}]*min-height:\s*92px/s);
	assert.match(styles, /\.workflow-gate:not\(:last-child\)::after[^}]*clip-path:/s);
	assert.doesNotMatch(styles, /\.(?:pipeline-stage|workflow-task|workflow-gate|stage-task-list)[^{]*\{[^}]*transform:\s*(?:translate|scale)/s, "stages, tasks, gates, and their connectors remain stationary, including hover");
	assert.doesNotMatch(styles, /@keyframes\s+(?:workflow-enter|active-pulse)/);
});

test("task and report details are action-loaded with an accessible centered modal and focus return", async () => {
	const [app, styles] = await Promise.all([readFile(appPath, "utf8"), readFile(stylesPath, "utf8")]);
	assert.match(app, /data-task=/);
	assert.match(app, /data-report=/);
	assert.match(app, /role="dialog"/);
	assert.match(app, /aria-modal="true"/);
	assert.match(app, /focusTarget \? root\.querySelector\(focusTarget\)/);
	assert.match(app, /captureInteractionState/); assert.match(app, /restoreInteractionState/); assert.match(app, /drawerScrollTop/);
	const workflowTask = app.slice(app.indexOf("function workflowTask"), app.indexOf("function gateDetails"));
	const workflowGate = app.slice(app.indexOf("function gate("), app.indexOf("function stageTasks"));
	assert.match(workflowTask, /<span class="sr-only">Open task detail/); assert.doesNotMatch(workflowTask, /aria-label="Open task/);
	assert.match(workflowGate, /<span class="sr-only">\$\{action\.label\}/); assert.doesNotMatch(workflowGate, /aria-label="Open \$\{escapeHtml\(label\)\} report/);
	assert.match(app, /event\.key === "Escape"/);
	assert.match(app, /class="detail-layer"/); assert.match(app, /inert aria-hidden/);
	assert.match(styles, /\.detail-layer[^}]*place-items: center/); assert.match(styles, /\.drawer[^}]*max-height:/);
	assert.match(styles, /\.scrim[^}]*background: var\(--color-scrim\)/);
});
