# PiBox interactive footer

This layer lets footer renderers share keyboard navigation and extension-owned setting dialogs without depending on the PiBox status-bar layout.

- Item owners register semantic status, section/order, and a dialog model in the process-wide registry.
- A footer renderer mounts `attachInteractiveFooter()` and supplies the currently visible grid of item ids.
- `Down` from an empty editor enters the grid. Arrow keys navigate it, Enter opens the selected overlay, and Up from the first row exits.
- Escape and unrelated keys are consumed while footer-grid mode is active, preventing accidental editor changes or agent interruption.
- The shared overlay supports detail, setting, and action rows. Arrow keys stay within the popup, and Escape closes it or cancels its active action.

The bundled registrations are Permissions, Effort, managed-agent Tier profile, Fast mode, and each PiBox service. Another footer can reuse the same registrations by rendering `listInteractiveFooterItems()` and mounting the controller with its own visible row layout.
