import type { ReactElement } from 'react';

/**
 * 纯文本长文排版：按**空行**切段，段间用 `--para-gap`；段内换行保留（`white-space: pre-wrap`）。
 * 不解析 markdown / HTML，不做富文本——只解决「多段文字挤成一坨」。
 */
export function ProseText({
  text,
  className,
  testId,
}: {
  text: string;
  className?: string;
  testId?: string;
}): ReactElement | null {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .filter((paragraph) => paragraph.trim().length > 0);
  if (paragraphs.length === 0) return null;
  return (
    <div className={className ? `prose ${className}` : 'prose'} data-testid={testId}>
      {paragraphs.map((paragraph, index) => (
        <p key={index} className="prose__p">
          {paragraph}
        </p>
      ))}
    </div>
  );
}
