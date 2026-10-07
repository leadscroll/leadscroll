# LeadScroll design guidelines

These guidelines capture the approved UI as of reference commit `c0ffdaa`.
Use them for future screens, not just this implementation. The reference source
and screenshots show exact details; HANDOFF.md defines production requirements.

## Design character

A compact, calm workbench. Give record content more emphasis than navigation.
Use alignment, spacing and separators to establish hierarchy. Prefer a few shared
page patterns over individually styled cards. Avoid decorative panels, repeated
explanations and configuration steps that do not help the current task.

## Foundations

Use semantic CSS custom properties. New pages must not select arbitrary palette
classes or override shared controls to invent variants. Extend a shared token or
component when a new behavior is justified.

| Role | Approved value |
| --- | --- |
| Main surface | #191B1D |
| Sidebar | #141618 |
| Raised surface | #202325 |
| Hover surface | #272B2D |
| Input surface | #1C1F21 |
| Primary text | #ECEEEF |
| Secondary text | #A4AAAE |
| Muted text | #92999E |
| Subtle / strong border | #2B2E31 / #3C4245 |
| Accent / hover | #E6A06B / #EFB589 |
| Accent foreground | #2A1B10 |
| Accent subtle / border | #34291F / #58402E |

The original logo keeps orange #FD6600, navy #161E27 and white. Reuse the supplied
SVG unchanged in the sidebar, sign-in identity and favicon. Do not redraw it or
replace it with a generic icon. The softer UI accent is intentional.

Use the existing Inter/system sans stack and Lucide icons. Most interface copy
is 12–13px, secondary metadata 11–12px, record identity around 23px. Use regular
and medium weights; reserve large/bold text for meaningful hierarchy. Keep money
and counts aligned with tabular numerals. Long values truncate or wrap deliberately.

Use the reference spacing rhythm (4/8/12/16/24/28/32/36px), 6px control radius and
8–12px panels. Primary controls are approximately 34px tall on desktop, 40px on
mobile. Small icon actions need visible focus and usable hit areas. Dropdown
carets are inset 12px with 40px reserved text padding; preserve native behavior
and forced-color fallback for native selects.

## Shared components and page patterns

- AppShell: consistent navigation, workspace identity and account access.
- PageHeader: compact breadcrumb/location and page-level actions.
- Lists: toolbar directly below header, compact table, meaningful selection bar,
  clear loading/error/empty/filtered-empty states, count and pagination footer.
- Lead records: one bounded 960px vertical column, identity -> tags -> details,
  intake metadata/raw payload -> activity. One document scrollbar; no side feed.
- Settings/catalogs: compact rows with one primary action, search, and overflow
  menus for uncommon operations. Avoid an introductory card on every screen.
- Dialogs: focused task, clear title, short optional explanation, aligned footer,
  constrained width/height and internal scrolling when the viewport is short.
- Reuse Button, Field, Form, Dialog, Avatar, TagChip/TagInput and menu patterns.
  Prefer Base UI interaction primitives rather than bespoke keyboard/focus logic.

## Buttons and validation

Primary = main commit/action; secondary = supporting action; ghost = quiet action;
danger = destructive confirmation. Submit stays enabled for invalid/incomplete or
unchanged values. Clicking validates, shows inline messages and focuses the first
invalid field. Preserve the draft. Unchanged saves explain that inline and make no
request. Disable only during an active submission, with an honest pending label
and a synchronous guard where needed. Retain server-side validation.

Use explicit labels, aria-invalid and aria-describedby links. Reuse native input
constraints while displaying messages inline rather than browser bubbles. Do not
use toasts for validation. Do not surface backend/implementation details as routine
product copy. Expected request failures should remain actionable and preserve input.

## Tags

`prefix:value` defines an exclusive scope globally. Plain tags are independent.
Names are shown in full in lead chips; catalog child rows may show only the value
under a scope heading. There are no dots or per-scope radio sections in tag pickers.

Scopes are created from a tag name, not a separate setup wizard. Scope colors apply
to every child tag; standalone tags have their own color. The catalog is one searchable,
expandable list with use counts, a color control and row actions. Per-tag deletion
explains affected leads; duplicate renames do not silently merge.

| Palette | Fill | Text |
| --- | --- | --- |
| Sage | #283530 | #BACFC4 |
| Blue | #27323E | #BACADA |
| Lavender | #302D39 | #C8C0D5 |
| Taupe | #363127 | #D2C5AE |

Lead tags start as a read-only display. Click to edit; Save tags and Cancel sit
next to the chip input. Changes, including scope replacement, remain a draft until
saved. Save shows a success toast and returns to display mode; Cancel/navigation
discards the draft. This save is independent of contact Save changes. Focus moves
to the input on edit and back to the display on completion. Escape never clears
assigned chips. Create-lead tags are part of the create form draft. Bulk edits have
explicit Apply and inline feedback for an empty selection.

## Notifications

Toasts appear bottom-right with dim status tint, a clear colored border and static
edge glow: 8px blur, 1px spread, approximately 28% opacity. No pulsing/flashing.
Keep readable text and status icons so color is not the sole cue. Close is inside
the upper-right corner with a 32px target and reserved content space.

| Status | Surface | Border |
| --- | --- | --- |
| Success | #1E2A23 | #68977B |
| Error | #2C2024 | #BA727E |
| Information | #2B251F | #B18B64 |
| Warning | #29261D | #B29C5C |

Use success to confirm a completed commit, information for meaningful consequences,
and actionable request-error feedback where appropriate. No success before persistence
succeeds. Undo must perform a real reversal; never ship a fake action. Notifications
support dismissal and hover-to-expand stacks. Errors should allow sufficient reading time.
The toast gallery belongs only to reference/development tooling.

## Responsive and accessibility checks

Check 390px mobile, ordinary desktop and wide desktop. Tables may scroll inside
containers; the document must not overflow horizontally. Menus/dialogs must fit the
viewport and preserve keyboard navigation. Test labels, focus return, Enter/Space,
Escape, chip removal, loading/disabled states, empty data and long text. Respect
reduced motion and forced colors. Maintain readable contrast; the approved primary
button pairing is about 7.6:1 and toast description text exceeds 5:1.

## Extending the UI

For each new screen: choose a shared page pattern; reuse tokens and controls;
define loading/empty/error/success behavior; decide which action commits each draft;
then verify real data and mobile/keyboard behavior. Put new recurring patterns in
the shared layer and document them with a small example. A screenshot alone is not
proof of a functional workflow, and a passing typecheck is not visual validation.
