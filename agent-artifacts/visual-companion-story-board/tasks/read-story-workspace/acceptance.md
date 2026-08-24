# Task Acceptance: Read lazy story workspace summaries and task details

## Deliverables

- Load one selected story’s task cards, task details, document catalog, and report summaries without reading document or report bodies prematurely.

## Acceptance

- Selecting a story loads task/document/report catalogs without loading narrative bodies
- Each valid task becomes one card with exact status and approved column mapping
- Task detail bodies load only for the selected task
- Malformed children degrade locally while valid siblings remain available
- Task/report relationships are represented in both summary directions

## Boundary Proof

- Workspace tests instrument filesystem reads and compare healthy, legacy, missing, and malformed child fixtures
