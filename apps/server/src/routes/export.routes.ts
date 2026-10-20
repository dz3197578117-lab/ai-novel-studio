import type { FastifyInstance } from 'fastify';
import { Document, Packer, Paragraph, HeadingLevel, AlignmentType, TextRun } from 'docx';
import type { Chapter, ExportFormat } from '@novelforge/shared';
import { listChapters, listChaptersWithContent, listVolumes } from '../repos/chapters.repo.js';
import { getProject } from '../repos/projects.repo.js';
import { exportRequest } from './schemas.js';

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>('/api/projects/:id/export', async (req, reply) => {
    const project = getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'not_found', message: '项目不存在' });

    const parsed = exportRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: '参数校验失败',
        details: parsed.error.flatten(),
      });
    }
    const { format, chapterIds, includeOutline } = parsed.data;

    // 一条查询取完正文：原来先 listChapters 再逐章 getChapter，1000 章要 1001 次查询
    const chapters = listChaptersWithContent(
      project.id,
      chapterIds?.length ? chapterIds : undefined,
    );

    const volumes = listVolumes(project.id);
    const volTitle = (id: string | null) =>
      id ? (volumes.find((v) => v.id === id)?.title ?? '') : '';

    const baseName = sanitize(project.title || 'novel');

    if (format === 'txt') {
      const body = chapters
        .map((c) => {
          const head = `${c.title}\n${'='.repeat(c.title.length)}\n`;
          const out = includeOutline && c.outline ? `【大纲】${c.outline}\n\n` : '';
          return `${head}${out}${c.content}`;
        })
        .join('\n\n\n');
      return reply
        .header('Content-Type', 'text/plain; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${encodeURIComponent(baseName)}.txt"`)
        .send(body);
    }

    if (format === 'md') {
      const parts: string[] = [`# ${project.title}`];
      if (project.logline) parts.push(`> ${project.logline}`);
      let lastVol = '__none__';
      for (const c of chapters) {
        const vt = volTitle(c.volumeId);
        if (vt && vt !== lastVol) {
          parts.push(`## ${vt}`);
          lastVol = vt;
        }
        parts.push(`### ${c.title}`);
        if (includeOutline && c.outline) parts.push(`> 大纲：${c.outline}`);
        parts.push(c.content);
      }
      return reply
        .header('Content-Type', 'text/markdown; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${encodeURIComponent(baseName)}.md"`)
        .send(parts.join('\n\n'));
    }

    // docx
    const children: Paragraph[] = [
      new Paragraph({ text: project.title, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
    ];
    if (project.logline) {
      children.push(new Paragraph({ text: project.logline, alignment: AlignmentType.CENTER }));
    }
    let lastVol = '__none__';
    for (const c of chapters) {
      const vt = volTitle(c.volumeId);
      if (vt && vt !== lastVol) {
        children.push(new Paragraph({ text: vt, heading: HeadingLevel.HEADING_1, pageBreakBefore: true }));
        lastVol = vt;
      }
      children.push(new Paragraph({ text: c.title, heading: HeadingLevel.HEADING_2 }));
      if (includeOutline && c.outline) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: `大纲：${c.outline}`, italics: true })],
          }),
        );
      }
      for (const line of c.content.split(/\n+/)) {
        if (line.trim()) children.push(new Paragraph({ text: line.trim() }));
      }
    }

    const doc = new Document({ sections: [{ children }] });
    const buf = await Packer.toBuffer(doc);
    return reply
      .header(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      )
      .header('Content-Disposition', `attachment; filename="${encodeURIComponent(baseName)}.docx"`)
      .send(buf);
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/stats', async (req, reply) => {
    if (!getProject(req.params.id)) {
      return reply.code(404).send({ error: 'not_found', message: '项目不存在' });
    }
    const chapters = listChapters(req.params.id);
    const totalWords = chapters.reduce((s, c) => s + c.wordCount, 0);
    const done = chapters.filter((c) => c.status === 'done').length;
    return {
      chapterCount: chapters.length,
      totalWords,
      doneChapters: done,
      volumeCount: listVolumes(req.params.id).length,
    };
  });
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'novel';
}

export type { ExportFormat };
