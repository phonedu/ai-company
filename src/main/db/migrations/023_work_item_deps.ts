/** 023：迁移内联常量（打包安全；与 023_work_item_deps.sql 逐字一致）。 */
export const SQL_023_WORK_ITEM_DEPS = `-- 023_work_item_deps.sql — B2-3/D-30②：多工作项 DAG（依赖限同任务内）＋返工件血缘。
-- 为什么：58 §6-2「1 任务=1 工作项」使调度多件队列永远喂不满；D-30② 推翻该裁决——
-- planner 产 2-N 件带依赖；调度按依赖门控；失败粒度=单件。
CREATE TABLE IF NOT EXISTS work_item_deps (
  work_item_id INTEGER NOT NULL REFERENCES work_items(id),
  depends_on   INTEGER NOT NULL REFERENCES work_items(id),
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (work_item_id, depends_on)
);
CREATE INDEX IF NOT EXISTS idx_work_item_deps_dep ON work_item_deps(depends_on);
-- 返工件血缘：spawnReworkItem 指向源件（同员工返工继承员工×任务×源件会话键）。
ALTER TABLE work_items ADD COLUMN retry_of INTEGER REFERENCES work_items(id);
`;
