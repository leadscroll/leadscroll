// Node 24 (the Vitest runtime) has no native Temporal; load the spec-compliant
// polyfill for the pure datetime unit tests. Browser bundles load it
// conditionally instead (see src/main.tsx).
// eslint-disable-next-line import/no-unassigned-import -- Side effect: registers the Temporal global.
import 'temporal-polyfill/global';
