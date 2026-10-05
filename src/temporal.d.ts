// Temporal is a finished standard (Stage 4), native in current Firefox and
// Chromium. `main.tsx` loads `temporal-polyfill/global` where it is missing
// (Safari/iOS); the polyfill's standalone types declare the global here.
// eslint-disable-next-line import/no-unassigned-import -- Registers the global Temporal types.
import 'temporal-polyfill/types/global';
