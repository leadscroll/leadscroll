# LeadScroll UI foundations

The working reference is the leads list, lead detail page, and create-lead dialog.
The design uses neutral charcoal surfaces, restrained warm emphasis, compact
navigation, and readable content. It is implemented in React and CSS; no runtime
UI generation or new styling dependency is required.

## Ownership

- `src/styles.css`: semantic tokens, shared control styles, and page patterns.
- `components/AppShell`: navigation, workspace identity, account access.
- `components/PageHeader`: location and page actions; shared with settings.
- `components/ui`: Button, Field, Dialog, Avatar, and input/select classes.
- Feature pages: content and workflow, using the shared foundations.

## Rules for new UI

1. Use semantic color roles (`--surface-base`, `--surface-raised`,
   `--text-primary`, `--text-secondary`, `--text-muted`, `--border-subtle`,
   `--accent`). Do not add per-page palette colors or override shared controls
   to get a new variant. Add justified variants centrally.
2. Use primary buttons for the page's main action; secondary for supporting
   actions, ghost for quiet actions, and danger in destructive confirmations.
   Include a pending label and disable duplicate submissions.
3. Keep location and page actions in PageHeader. List controls belong in the
   toolbar below it. Group record details using section headings and separators.
4. Form labels, fields, hints, errors, and actions follow the shared Field,
   inputClass, and form-footer patterns. RHF and API contracts retain ownership
   of form behavior and validation.
5. Use one icon family (Lucide), normally 14–16px in controls. Icon-only actions
   require accessible names. Decorative avatars and icons must not repeat labels
   to assistive technology.
6. Preserve focus indicators, dialog focus containment and return, keyboard
   operation, disabled states, and reduced-motion preferences.
7. Check desktop, narrow desktop, and 390px mobile widths. Wide tables may scroll
   inside their container; the document must not overflow horizontally. Dialogs
   must fit short viewports and scroll internally.
8. Check loading, empty, filtered-empty, error, selected, and long-content states
   alongside populated screens. Never hide an API error behind an empty state.

## Current scope

The slice is dark-theme only. Settings inherit the shared shell, header, controls
and neutral palette but retain their previous layouts. The Tailwind slate/cyan
aliases are a temporary compatibility bridge for those screens, not a second
palette for new components. A component gallery and permanent screenshot test
harness are follow-up work once the visual direction is accepted.

## Tags: interactive proposal

The `design-preview` Vite mode adds a browser-memory tag catalog. It is gated by
both DEV and MODE; normal development and production builds do not enable it.
The preview server supplies fictional lead IDs; reloading resets tag edits.

- Scopes are inferred from `prefix:value` names and always exclusive. Each scope
  owns one shared color; there is no per-scope exclusivity setting.
- Tags have stable IDs; renaming a group changes displayed names without losing assignments.
- Picking an exclusive tag replaces its sibling, preserving other groups and independent tags.
- Lead tags start as a read-only chip display. Clicking opens the inline chip input
  with its own Save tags and Cancel actions. Scoped swaps affect only the draft.
  Save commits and shows Tags saved; Cancel discards. Contact Save changes is separate.
  Unchanged tag saves show inline feedback; bulk changes remain staged until Apply.
- Bulk add replaces same-prefix tags; bulk remove affects only selected tags.
- List filters match one exact tag or any tag in a prefix. Preview filtering uses
  the loaded fictional list; production needs server-side filtering/pagination.
- Renaming a tag into another scope is blocked if assigned leads already have
  another value in that scope. Catalog maintenance never silently drops assignments.
- Deleting a tag removes its assignments after confirmation; leads remain.

This is a UI proposal, not a tags API. Durable storage, authorization and atomic
exclusivity enforcement belong in a later backend implementation.

### Source and intake-token proposal

In the preview, `source` is an exclusive tag prefix, with website, referral,
event and manual examples. The standalone source input/column is hidden only
in this mode. Real API fields and source request mappers remain unchanged.
Manual preview leads start with `source:manual`.

The intake-token route uses the normal token list and creation UI. For the current
design, incoming payloads may supply any tags. Per-token fixed tags, allowlists,
tag-creation restrictions and the submission simulator were removed. This is a
provisional product assumption; ingestion/storage behavior is still future work.

### Chip input interaction

`TagInput` uses Base UI Combobox with removable chips and a flat searchable dropdown.
There are no radio controls, per-scope sections, or No tag rows. Scoped selection
uses the same addTags policy; choosing a sibling replaces the prior selection.
Independent tags accumulate. The create form uses the same input without a nested
dialog; draft tags are saved only when the lead is created. Bulk removal permits selecting several tags from one exclusive scope so any
existing assignments can be removed.

Keyboard: type to filter, arrows/Enter to select, Escape to dismiss, and chip
removal via × or the component's chip keyboard navigation. The popup is anchored
to the input and sized for mobile. Production does not enable this preview UI.

Tag colors use quiet, desaturated fills with coordinated readable text: sage,
slate blue, lavender and taupe. There are no decorative dots or outline borders.
Display chips, dropdown options and removable selected chips share the palette;
the selected chip's × sits on the same fill.

## Brand

The app reuses the original scroll/cloud mark from the September 2026 brand gig,
unchanged as `public/brand/leadscroll-mark.svg`. BrandMark shares it between the
sidebar and sign-in screen; the same asset is the favicon. The mark keeps its
original navy #161E27, orange #FD6600 and white. UI accents use a quieter apricot
#E6A06B, hover #EFB589, foreground #2A1B10, subtle fill #34291F and border #58402E.
Primary text/background contrast is 7.61:1. Tag category fills remain independent
of the brand accent so dense lists retain their muted palette.

## Toasts

Sonner notifications use status-tinted dark surfaces, clearer colored borders,
and a soft matching outer glow. Success, error and information retain distinct icons. Notifications
appear at bottom right, can be dismissed, and a hovered stack expands and pauses
its timers. Actions use the warm accent treatment. The design-only route
`/preview/toasts` demonstrates success, error, information, loading-to-success
and undo without changing application data.

Toast close controls sit inside the upper-right corner with reserved content
space and a 32px target. Borders and surfaces carry status tints: sage for success,
rose for errors, warm tan for information, and amber for warnings. Text and icons
still communicate status independently of color.

Lead detail uses one vertical record column (maximum 960px): identity, tags,
contact details, then activity. Activity grows with the document; it has no
independent scrolling panel. Name fields can share a desktop row and stack on mobile.

## Token expiration

Use one Expiration select: 7 days, 30 days, 90 days (default), Never, Custom date.
Presets show a short local expiry-date summary; Never says Valid until revoked.
Only Custom date reveals the datetime-local input and timezone hint. Custom input
is required and keeps the existing future-date/DST-gap validation. Switching modes
preserves a custom draft and clears hidden errors. Reopening resets to 90 days.

Preset durations are elapsed 24-hour days from the most recent selection (or dialog
opening). The summary and request share that reference instant. The wire contract
remains expiresAt ISO UTC for expiring tokens and null for Never.

Single-select controls keep native selection behavior with a shared decorative
caret inset 12px from the right edge and 40px reserved text padding. Forced-color
mode restores the platform arrow. The chip-input trigger uses comparable spacing.

Toast glows are static and concentrated at the edge (8px blur, 1px spread,
28% opacity), with dim status-tinted backgrounds; they do not pulse or flash.
Description text maintains at least 5.25:1 contrast across the status surfaces.

## Inline form validation

Submit buttons stay enabled for incomplete, invalid and unchanged forms. They
are disabled only while a submission is pending, with a pending label. Clicking
an unchanged save shows No changes to save inline without issuing a request.

The shared Form preserves native required/type/min/pattern constraints but uses
noValidate to replace browser validation bubbles with inline Field messages.
It focuses the first invalid control and blocks submission. RHF continues to
own field/business rules. Field links labels, hints and errors to controls with
IDs and aria-describedby/aria-invalid; error messages are live announcements.
Validation preserves the draft and does not trigger a toast. Request errors stay
inline; successful-action notifications remain separate from validation.

Tag edit mode focuses the combobox; Save and Cancel return focus to the display.
Navigating away discards the tag draft. Saving tags does not reset contact-field drafts.

## Compact tag management

The Tags page is one searchable list with expandable scope rows. New tag accepts
one full name such as `fall26:considering`; the scope is inferred or created and
its existing color is inherited. Plain tags stay independent. Scope color controls
update all child tags; standalone tags have their own controls. Child rows show
only the value and have no separate color control.

Each tag's overflow menu has Rename and Delete. Rename retains its ID and lead
assignments; collisions show an inline error rather than merging. Delete confirms
the affected lead count and removes only that tag. Empty inferred scopes disappear
after their last tag is removed. Scope menus offer New tag and Rename scope;
scope renaming preserves assignments and rejects existing-prefix collisions.

The input currently supports a plain name or one `scope:value` separator, trims
and normalizes case, and limits scope/value to 30/40 characters. This remains a
browser-memory proposal; the actual intake/API migration is separate.
