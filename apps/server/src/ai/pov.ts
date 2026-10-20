import type { NarrativePov, Project } from '@novelforge/shared';

export const POV_LABEL: Record<NarrativePov, string> = {
  auto: '未指定（由文风与正文推断）',
  first: '第一人称限知',
  'third-limited': '第三人称限知',
  'third-omniscient': '第三人称全知',
  multi: '多视角轮换',
};

type FixedPov = Exclude<NarrativePov, 'auto'>;

/**
 * 每种视角的硬性守则。
 * 这些是「违反即算写错」的规则，注入时放在硬约束之后、记忆之前。
 */
const RULES: Record<FixedPov, string[]> = {
  first: [
    '叙述一律用「我」，不得用角色名指代自己（台词、他人转述、作者刻意写的回忆除外）',
    '只写「我」的所见、所闻、所感、所想',
    '不得直接描写他人内心，只能通过表情、动作、语气推测',
    '不得描写我不在场或感知不到的场景',
  ],
  'third-limited': [
    '每一章只跟一个视角人物，只写他/她的所见所感',
    '同一场景内不得跳进其他角色的内心（head-hopping）',
    '视角人物不在场的场景不得直接描写',
    '同场多人时用名字区分，避免「他」指代混乱',
  ],
  'third-omniscient': [
    '叙述者可进入任何角色的内心，也可叙述任何时间与地点',
    '但不得提前泄露后文才该揭晓的信息',
    '全知与限知不要在同一段里来回横跳',
  ],
  multi: [
    '每个场景只跟一个视角人物，场景内不得跳视角',
    '切换视角时用空行或分节标记明确隔开',
    '切换后首次提到当前视角人物，用名字点明',
  ],
};

export function povLabel(pov: NarrativePov | undefined): string {
  return POV_LABEL[(pov ?? 'auto') as NarrativePov] ?? POV_LABEL.auto;
}

/** 没有声明切换规则时的默认口子：换章、换节、时空跳转 */
const DEFAULT_SWITCH_SLOTS = '章节开头、分节处、时间或地点跳转之后，可以换视角人物';

const MARKER_RULE = '必须有可辨识的标记：空行分节、小节标题、或另起一段以人名开头';

/**
 * 生成注入用的视角守则。
 *
 * 关键：给的是「默认视角 + 例外条款」，不是「全书唯一视角」。
 * 长篇不可能一种视角写到底——限死会把合法的场景切换也判成错误，
 * 模型真遇到需要换视角的段落时会硬撑，写出别扭的「假装不知道」。
 * 未指定（auto）时返回 null，保持老作品行为不变。
 */
export function buildPovGuide(project: Project): string | null {
  const pov = (project.pov ?? 'auto') as NarrativePov;
  if (pov === 'auto') return null;

  const switchRule = (project.povNote ?? '').trim();
  const lines = [
    `本书**默认**「${povLabel(pov)}」，单个场景之内保持这个视角。`,
    ...RULES[pov as FixedPov].map((r) => `- ${r}`),
    '',
    '**允许的切换**：',
    switchRule
      ? switchRule
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => `- ${l}`)
          .join('\n')
      : `- ${DEFAULT_SWITCH_SLOTS}`,
    `- ${MARKER_RULE}`,
    '- 同一个场景内（时间连续、地点未变、人物未离场）不得从一个人的内心跳到另一个人的内心',
  ];
  return lines.join('\n');
}

/**
 * 给一致性检查用的判定标准。
 * 必须区分「合法切换」和「越界」——否则检查器会把正常的多视角写法全判成违规。
 */
export function buildPovCheckNote(project: Project): string {
  const pov = (project.pov ?? 'auto') as NarrativePov;
  if (pov === 'auto') {
    return '本书未指定视角。先推断正文实际人称（「我」还是「他」），再查前后是否一致。';
  }

  const switchRule = (project.povNote ?? '').trim();
  return [
    `本书默认「${povLabel(pov)}」。`,
    switchRule
      ? `作者声明的切换规则：${switchRule}`
      : `作者未声明额外规则，只允许在${DEFAULT_SWITCH_SLOTS}。`,
    '判定标准：',
    `- 切换落在上述规则之内、且${MARKER_RULE} → 不报`,
    '- 切换在规则之内但没有标记，读者分不清谁在看 → 报 medium',
    '- 切换不在规则之内，或发生在同一场景内 → 报 medium',
    '- 场景内跳进非视角人物内心（head-hopping）→ 报 high',
    '- 只写视角人物感知不到的信息（他不在场、听不到、看不见）→ 报 high',
  ].join('\n');
}
