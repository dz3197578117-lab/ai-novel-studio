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

/**
 * 生成注入用的视角守则。未指定（auto）时返回 null，保持老作品行为不变。
 */
export function buildPovGuide(project: Project): string | null {
  const pov = (project.pov ?? 'auto') as NarrativePov;
  if (pov === 'auto') return null;
  const lines = [`本书为「${povLabel(pov)}」。`, ...RULES[pov as FixedPov].map((r) => `- ${r}`)];
  const note = (project.povNote ?? '').trim();
  if (note) lines.push(`- 作者补充：${note}`);
  return lines.join('\n');
}

/** 给一致性检查用的「设定说明」，让它以设定为基准而不是从正文反推 */
export function buildPovCheckNote(project: Project): string {
  const pov = (project.pov ?? 'auto') as NarrativePov;
  if (pov === 'auto') {
    return '本书未指定叙述视角。请先从正文推断实际人称（「我」还是「他」），再检查是否前后一致。';
  }
  const guide = buildPovGuide(project);
  return `本书设定为「${povLabel(pov)}」。检查时以此为基准，不要从正文反推。\n${guide ?? ''}`;
}
