# Visual Companion design system

## Design Goal

Give every Visual Companion viewer one restrained professional visual language and eliminate architecture-specific hard-coded styling by making semantic design tokens the sole source for shared color, typography, spacing, geometry, elevation, focus, and motion decisions.

## Chosen Approach

- Provide one shared browser token asset served by the companion backend and consumed directly by the shell, Story Board, Markdown presentation, and Architecture assets.
- Use graphite-neutral canvas and surface colors instead of the current blue-green cast: canvas #0c0e12; surfaces #12151b, #181c24, and #202631; hover surface #262d39; subtle, default, and strong borders #252b35, #313946, and #465163.
- Use text colors #f2f4f7 primary, #b8c0cc secondary, #7f8998 muted, #596270 disabled, and #0c0e12 inverse.
- Use #7697e8 as the primary interaction accent with #89a7ee hover and a 14-percent soft treatment. Use #6fbd8c success, #d9a85f warning, #d87878 danger, and #6eaed4 information, each with a restrained soft background where needed.
- Allow only restrained gradients: a subtle dark elevated-surface gradient, a near-neutral translucent header gradient, and a blue-to-muted-violet accent gradient reserved for rare emphasis rather than ordinary cards.
- Use Inter followed by the native system sans stack, a platform monospace stack for machine content, an 11-to-20px type range, tight headings, 1.5 normal line height, and 1.65 reading line height for Markdown.
- Use a four-pixel spacing foundation with named steps 4, 8, 12, 16, 20, 24, 32, and 40px; radii 4, 6, 8, and 12px plus pill; and one-pixel borders.
- Use shadows only for true elevation: a restrained small surface shadow, an overlay shadow, and a left-cast drawer shadow. Ordinary cards establish hierarchy through surface and border tokens rather than decorative elevation.
- Use 120ms fast and 160ms normal motion with a standard deceleration curve, honor reduced-motion preferences, and never animate content in a way that blocks navigation.
- Set shared application geometry tokens for the 68px header, approximately 1180px story content width, 288px Kanban lane, and 464px detail drawer. At narrow widths, the drawer becomes a full-height sheet.
- Require visible accent-colored focus rings, meaningful hover/active/disabled states, and status communication through text or icon in addition to color.
- Cytoscape styling resolves semantic CSS variables through computed styles so graph nodes, edges, selection, actor, decision, data, warning, and group treatments do not create a second palette.

## Verification Boundaries

- Static checks reject hard-coded shared palette values outside the token source and explicitly documented visualization data mappings.
- Computed-style checks prove shell, Story Board, Markdown, and Architecture consume the expected semantic token values.
- Browser screenshots cover catalog, task board, task drawer, Documents, Reports/evidence, loading/error states, Architecture, focus states, and narrow viewport sheet behavior.
- Accessibility checks verify contrast-sensitive text/status combinations, visible focus, reduced-motion support, and non-color status communication.
- Architecture interaction checks prove token extraction does not regress graph controls, selection, details, or live refresh.

## Components and Interfaces

- Shared semantic token CSS asset covering primitive values and component-facing aliases
- Base/reset layer for box sizing, typography, canvas, focus, reduced motion, and safe defaults
- Shell primitives for header, tabs, content regions, loading, empty, degraded, and error states
- Story Board primitives for catalog rows, badges, Kanban lanes/cards, accordions, Markdown, report items, evidence, drawer, and mobile sheet
- Architecture semantic adapter that maps graph concepts to the shared interaction and semantic tokens
- Visual fixture pages and screenshots that make token drift observable across desktop and narrow viewports

## Data and Control Flow

- The backend exposes the shared token asset from one stable common route.
- Every viewer loads the shared tokens before viewer-specific component rules.
- Viewer-specific styles reference semantic variables and may add layout rules but may not introduce independent palette values for shared concepts.
- Architecture JavaScript reads resolved CSS variables once when creating graph styles and refreshes those values when the viewer theme context changes.
- Responsive rules consume shared geometry and spacing tokens, while reduced-motion and focus behavior inherit from the base layer.

## Failure and Recovery

- If the shared token asset cannot load, the shell must remain readable through conservative CSS fallbacks rather than presenting transparent or same-color text and surfaces.
- Unknown story or task statuses use neutral styling plus exact status text instead of guessing a semantic color.
- Long Markdown, labels, and task titles wrap without changing token values or relying on fixed graph-oriented dimensions.
- Narrow viewports retain details through a sheet and do not repeat the current Architecture behavior of hiding the details surface.
- Token migration must not alter Architecture document data, graph semantics, or interaction behavior.

## Alternatives Considered

- Retaining the current Architecture palette and visually matching Story Board to it was rejected because the existing blue-green cast and graph-specific values do not provide a professional general application system.
- Maintaining separate JavaScript and CSS token objects was rejected because duplicated values would drift; computed CSS variables allow graph JavaScript to consume the browser source of truth.
- Heavy gradients, neon accents, widespread shadows, and large radii were rejected because they conflict with the requested minimal professional presentation.
- Introducing runtime theme switching in v1 was deferred; the token architecture should permit later themes without expanding this story's behavior.
