// Naming: runtime schema values end in `Schema` (`CreateLeadRequestSchema`,
// `LeadViewSchema`); derived TypeScript types use the plain domain name
// (`CreateLeadRequest`, `LeadView`). Request schemas validate wire input and
// their type is what commands receive; response schemas are the wire shape
// shared with the SPA. No `Input`/`I` markers: a derived type is not always
// an input.

export * from './access';
export * from './account';
export * from './audit';
export * from './common';
export * from './email';
export * from './leads';
export * from './tags';
