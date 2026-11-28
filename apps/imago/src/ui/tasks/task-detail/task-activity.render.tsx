import type { ReactNode } from 'react';
import { isAgentAccount } from '@pagespace/lib/auth/agent/display-name';
import { ImagoOrb } from '../../metal/imago-orb/imago-orb';
import { renderAgentMark } from '../../components/agent-mark/agent-mark.render';
import type { ActivityRow } from './task-activity';
import {
  taskActivityListClass,
  taskActivityRowClass,
  taskActivityTextClass,
  taskActivityTimeClass,
  taskSectionClass,
  taskSectionHeadingClass,
} from './task-detail-class';

/** The task's Activity: who did what and when, Imago's changes marked with its orb. */
export function renderTaskActivity(rows: readonly ActivityRow[]): ReactNode {
  if (rows.length === 0) return null;
  return (
    <section aria-label="Activity" className={taskSectionClass}>
      <h3 className={taskSectionHeadingClass}>Activity</h3>
      <ol className={taskActivityListClass}>
        {rows.map((row) => (
          <li key={row.id} className={taskActivityRowClass}>
            {row.byImago ? <ImagoOrb size="glyph" /> : null}
            <span className={taskActivityTextClass}>
              {isAgentAccount(row.accountType) ? (
                <>
                  {row.actor} {renderAgentMark({ accountType: row.accountType })} {row.action}
                </>
              ) : (
                <>
                  {row.actor} {row.action}
                </>
              )}
            </span>
            <span className={taskActivityTimeClass}>{row.time}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
