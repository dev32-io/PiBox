# Task Acceptance: Load canonical reports, history, risk acceptance, and evidence

## Deliverables

- Expose independently browsable report details and only manifest-authorized canonical evidence through contained asynchronous readers.

## Acceptance

- Reports remain independent from task details and preserve optional task links
- Attempt history, findings, risk acceptance, and manifest metadata are readable on demand
- Only manifest-listed canonical copied files can be served
- Missing or malicious evidence degrades locally without leaking filesystem paths or breaking the report

## Boundary Proof

- Focused report/evidence tests use sanitized canonical fixture layouts and explicit attack cases
