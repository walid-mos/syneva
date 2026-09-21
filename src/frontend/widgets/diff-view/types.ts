import type { AnnotationMeta } from '@entities/review/annotations'
import type { DiffLineAnnotation } from '@pierre/diffs'

// Our annotation payload handed to @pierre/diffs' renderAnnotation. The library's
// DiffLineAnnotation distributes over a union metadata type (one member per variant), so an
// annotation value is built as the member matching its metadata and the distributed union is the
// ARRAY's element type - never a single object's. Using the library's own type here keeps the two
// in step: a new variant can't be spelled on one side only.
export type AnnotationInput = DiffLineAnnotation<AnnotationMeta>
