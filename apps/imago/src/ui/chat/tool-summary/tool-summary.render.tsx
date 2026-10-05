import type { ReactNode } from 'react';
import { Icon } from '../../components/icon/icon';
import type { ToolCallSummary } from './tool-summary';
import {
  toolDetailClass,
  toolStateClass,
  toolSummaryClass,
  toolSummaryLineClass,
  toolTargetClass,
} from './tool-summary-class';

const section = (title: string, text: string | null): ReactNode =>
  text === null ? null : (
    <pre className={toolDetailClass}>
      {title}
      {'\n'}
      {text}
    </pre>
  );

/**
 * One tool call as one line that expands: a native disclosure, so it opens
 * from the keyboard and needs no state. Input and output are text, never
 * markup, whatever a tool returned.
 */
export function renderToolSummary(tool: ToolCallSummary): ReactNode {
  return (
    <details key={tool.id} className={toolSummaryClass} data-tool={tool.state}>
      <summary className={toolSummaryLineClass}>
        <Icon name="chevronRight" size={12} className="transition-transform duration-120 ease-standard group-open:rotate-90" />
        <Icon name="tool" size={12} />
        <span className="flex-none font-medium">{tool.name}</span>
        {tool.target === null ? null : <span className={toolTargetClass}>{tool.target}</span>}
        <span className={toolStateClass(tool.state)} data-state="">
          {tool.state}
        </span>
      </summary>
      {section('Input', tool.input)}
      {section(tool.state === 'failed' ? 'Error' : 'Output', tool.output)}
    </details>
  );
}
