/** `src/main/seams` 公共出口（OPT-M4-1 接缝矩阵：枚举真源 + 门禁）。 */
export {
  SEAM_BOUNDARIES,
  SEAM_BOUNDARY_LABELS,
  isSeamBoundary,
  checkSeamMatrix,
  type SeamBoundary,
  type SeamStatus,
  type SeamMatrixCell,
  type SeamMatrixIssue,
} from './boundaries.js';
