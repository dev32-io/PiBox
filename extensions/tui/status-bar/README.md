# PiBox status bar

A responsive two-row footer for model, provider, project, Git, thinking, current context occupancy, cumulative session tokens/cache/cost, and elapsed time.

Layouts switch explicitly at 110 and 72 columns. Unknown context and unreported cost are omitted rather than represented as zero.

Git status uses one asynchronous `git status --porcelain=v2 --branch` process every 10 seconds, with a three-second timeout, single-flight protection, failure backoff, cached rendering, and early refresh after file/Git-related activity. No subprocess runs from `render()`.

Runtime config-file installation is intentionally deferred; validated defaults live in `config.ts`.
