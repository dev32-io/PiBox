# Visual diff example

This copyable example compares one designer-rendered component reference with one implementation screenshot. PiBox does not own the project's capture setup, baseline policy, or test framework.

## Use

Copy this directory into a project—for example as `tools/visual-diff/`—install its pinned dependency, and run the wrapper from the project root:

```bash
npm --prefix tools/visual-diff install
node tools/visual-diff/visual-diff.mjs \
  design/prototypes/buttons/handoff/static/action-button--pressed.png \
  build/visual-captures/action-button--pressed.png
```

The command writes compact JSON to stdout and, when pixels differ, writes `<actual-name>.visual-diff.png` beside the actual image.

For tolerant comparison or a verification gate:

```bash
node tools/visual-diff/visual-diff.mjs reference.png actual.png \
  --threshold 0.1 \
  --max-diff-percentage 1 \
  --diff artifacts/action-button.diff.png
```

- `--threshold` controls ODiff's per-pixel color tolerance.
- Anti-aliased pixels are ignored by default; pass `--count-antialiasing` to include them.
- Without `--max-diff-percentage`, a completed comparison is report-only and exits `0` even when differences are reported.
- With `--max-diff-percentage`, exceeding the limit or encountering a layout mismatch exits `1`.
- Invocation, decode, and filesystem errors exit `2`.

A project can invoke the wrapper once per static state or keyframe, loop over files using its own test infrastructure, change defaults, or call [`odiff-bin`](https://github.com/dmtrKovalenko/odiff) directly.

## Project and platform setup guidance

PiBox supplies the approved mockup renders and this pairwise comparator. The project remains responsible for producing the implementation image. Prefer the project's existing screenshot-test infrastructure rather than adding another capture framework solely for PiBox.

Regardless of platform:

1. Render the same single component instance, content, variant, and state shown by the selected handoff reference. One implementation preview should correspond to one reference file.
2. Capture the isolated component rather than a specimen row, variant collection, or unrelated full application screen.
3. Stabilize data, fonts, theme, locale, scale, and animation through the project's normal fixture facilities.
4. Do not resize either image merely to make the comparison run; a layout mismatch is useful evidence.
5. Start with report-only comparison while implementing. Add `--max-diff-percentage` only when the project has reviewed representative good and bad results.
6. For motion, compare the corresponding PNG keyframes individually. A project-owned loop or test parameterization is sufficient; PiBox does not require keyframe manifests or filename conventions.

### Vite and browser applications

[Playwright Test screenshot support](https://playwright.dev/docs/test-snapshots) is the recommended default. A project can render a component route or fixture, select the component with a stable locator, and write an implementation image with `locator.screenshot()`:

```ts
const component = page.getByTestId("action-button-fixture");
await component.screenshot({
  path: "build/visual-captures/action-button--pressed.png",
  animations: "disabled",
});
```

Use fixed fixture data and viewport configuration. When the reference represents a transition keyframe, let the fixture expose the intended state or control its clock explicitly rather than relying on a wall-clock delay. Playwright MCP is not required for repeatable project capture; a normal Playwright test or script is cheaper and easier to reproduce.

### Android Compose

Use the project's existing Compose screenshot framework when it has one. Recommended choices are:

- [Roborazzi](https://github.com/takahirom/roborazzi) for Compose or View fixtures, interactions, and repository-oriented screenshot workflows.
- [Compose Preview Screenshot Testing](https://developer.android.com/studio/preview/compose-screenshot-testing) for projects already expressing stable states as previews.
- [Paparazzi](https://cashapp.github.io/paparazzi/) for host-rendered Compose/View snapshots.

For motion keyframes, Compose's [test clock](https://developer.android.com/develop/ui/compose/animation/testing) can pause automatic advancement and move to explicit logical times before each capture. The Gradle test or fixture chooses where actual PNGs are written and invokes this wrapper afterward.

### iOS and SwiftUI

[Point-Free SnapshotTesting](https://github.com/pointfreeco/swift-snapshot-testing) is the recommended default for fixed SwiftUI/UIKit fixtures and repository snapshots. Existing XCTest/XCUITest screenshot capture or a project-specific `ImageRenderer` fixture is also acceptable.

Keep the simulator/device configuration, proposed size, color scheme, locale, Dynamic Type setting, and fixture data explicit in the project's test. Represent motion as deterministic view states or injected progress/clock values and capture the corresponding PNG keyframes. SwiftUI does not need to adopt a PiBox-specific preview or sequencing protocol.

### Other platforms

Any deterministic mechanism that emits a supported image is sufficient. ODiff accepts PNG, JPEG, WebP, and TIFF, although lossless PNG is recommended for UI captures. The project may wrap the comparator in its native test runner, a shell script, CI, or an agent implementation loop.

### CI and baseline policy

The designer-generated handoff image remains the visual reference. Implementation jobs should generate actual images into a disposable build or artifact directory; they should not overwrite the designer references. Store diff PNGs and JSON reports as CI artifacts when useful. Projects may additionally maintain their own platform regression baselines, but those policies are independent of PiBox's mockup comparison guidance.
