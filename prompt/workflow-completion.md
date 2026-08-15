All execution and evaluation steps for workflow {{workflowId}} have settled. Apply the completion gate with `work_item_complete` using the bare work-item ID `{{workflowId}}`, then give the user a concise but informative delivery briefing; do not reply silently.

Read {{outcomePath}} if it already exists. Its absence before `work_item_complete` is expected—the completion gate creates it—and is not a deviation. Reconcile the resulting outcome with the task/evaluation results and workflow events you observed.

Report what was delivered, verification and review outcomes, genuine deviations, residual risks or follow-up, and the checked-out working branch.

{{worktreeGuidance}}

{{branchGuidance}}