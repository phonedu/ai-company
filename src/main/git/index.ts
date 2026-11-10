/** `src/main/git` 公共出口（：分支/提交/合并/diff； 部分只做 worktree + 路径白名单提交）。 */
export {
  WorktreeManager,
  createGitRunner,
  commitPaths,
  commitAll,
  hasWorkingTreeChanges,
  listChangedPaths,
  isLockfilePath,
  initGitRepo,
  resolveTaskWorkspace,
  findWorktreeByBranch,
  branchName,
  worktreePathFor,
  defaultWorktreesBaseDir,
  type GitRunner,
  type GitResult,
  type WorktreeInfo,
  type TaskWorkspaceInput,
} from './worktree.js';
export {
  mergeChangeset,
  projectRootForTask,
  type MergeChangesetInput,
  type MergeChangesetResult,
} from './merge.js';
export {
  rollbackChangeset,
  type RollbackChangesetInput,
  type RollbackChangesetResult,
} from './checkpoint.js';
export {
  discardChangeset,
  type DiscardChangesetInput,
  type DiscardChangesetResult,
} from './discard.js';
