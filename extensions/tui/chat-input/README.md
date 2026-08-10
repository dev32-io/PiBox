# PiBox chat input

Installs an original `CustomEditor` frame with a cyan `❯` prompt, adaptive thinking-level border, Bash-mode amber, embedded viewport labels, and native autocomplete below the box.

The component preserves Pi's editing and application keybindings by extending `CustomEditor`. At widths below 20 columns it falls back to Pi's native rail editor.

Defaults are defined and validated in `config.ts`. Runtime config-file installation is intentionally deferred.
