import { listEntities } from '../repos/entities.repo.js';
import { listOpenForeshadows, listTimeline } from '../repos/consistency.repo.js';
import { getProject } from '../repos/projects.repo.js';

const TYPE_LABEL: Record<string, string> = {
  world: '世界观',
  character: '人物',
  faction: '势力',
  term: '名词',
  item: '物品',
  location: '地点',
};

/**
 * 把设定库压成一段「硬约束」文本，注入到目录/大纲/整改这些规划类提示词里。
 *
 * 为什么需要：正文写作的上下文（ai/context.ts）本来就会注入设定，
 * 但生成大纲的那几条链路没接，导致模型凭空造人物、造势力，
 * 大纲和设定对不上。规划阶段同样必须知道「这个世界里谁存在」。
 *
 * 顺序有讲究：作者硬约束（rules）→ 设定条目 → 伏笔 → 时间线。
 * 前面的优先级更高，后面的不能与之冲突。
 */
export function buildSettingBrief(
  projectId: string,
  opts: { maxEntities?: number; maxForeshadows?: number; maxTimeline?: number } = {},
): string {
  const { maxEntities = 40, maxForeshadows = 10, maxTimeline = 8 } = opts;

  const entities = listEntities(projectId).slice(0, maxEntities);
  const foreshadows = listOpenForeshadows(projectId, maxForeshadows);
  const timeline = listTimeline(projectId)
    .filter((t) => t.importance >= 2)
    .slice(0, maxTimeline);

  const parts: string[] = [];

  // 作者写死的硬约束放最前面：制度、考据、禁令，优先级高于一切推断
  const rules = getProject(projectId)?.rules?.trim();
  if (rules) {
    parts.push(
      `## 作者硬约束（最高优先级：违反即视为写错，不要用常识或想象去改它）\n${rules}`,
    );
  }

  if (entities.length) {
    parts.push(
      `## 设定（硬约束：只能使用这些人物/势力/地点/规则，不要发明设定里没有的名字）\n` +
        entities
          .map(
            (e) =>
              `- [${TYPE_LABEL[e.type] ?? e.type}] ${e.name}${
                e.aliases.length ? `（又称 ${e.aliases.join('、')}）` : ''
              }：${e.summary || e.body.slice(0, 80)}`,
          )
          .join('\n'),
    );
  }

  if (foreshadows.length) {
    parts.push(
      `## 尚未回收的伏笔（可以呼应或铺垫，但不要提前揭晓）\n` +
        foreshadows.map((f) => `- ${f.title}${f.detail ? `：${f.detail.slice(0, 60)}` : ''}`).join('\n'),
    );
  }

  if (timeline.length) {
    parts.push(
      `## 已确定的时间线（不要写反先后顺序）\n` +
        timeline.map((t) => `- ${t.storyTime || '（未标时间）'}：${t.title}`).join('\n'),
    );
  }

  return parts.join('\n\n');
}
