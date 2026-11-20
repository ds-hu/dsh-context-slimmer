/**
 * Shared pure library of the dsh-context-slimmer bundle.
 *
 * Not a Loader row: it declares neither `dsh.bundle` nor `dsh.client`, so the
 * native Plugins panel cannot toggle it and no feature module can accidentally
 * unmount it. Every module package depends on it for the event protocol, the
 * replacement primitive, plan validation, prompt building, counters and the
 * configuration schema.
 *
 * The subpath exports are the public surface; import them directly, e.g.
 * `import { selectTargets } from '@ds-hu/dsh-context-slimmer-core/replace'`.
 *
 * @module @ds-hu/dsh-context-slimmer-core
 */

export * from './events.js'
export * from './plan.js'
export * from './templates.js'
