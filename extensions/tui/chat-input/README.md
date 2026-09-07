# PiBox chat input

Installs an original `CustomEditor` frame with a cyan `❯` prompt, adaptive thinking-level border, Bash-mode amber, native editor content ↑/↓ N more indicators, and native autocomplete below the box.

The component preserves Pi's editing and application keybindings by extending `CustomEditor`. Transcript navigation, including Pi's native Jump to latest message action, remains owned by Pi. At widths below 20 columns the component falls back to Pi's native rail editor.

Defaults are defined and validated in `config.ts`. Runtime config-file installation is intentionally deferred.
