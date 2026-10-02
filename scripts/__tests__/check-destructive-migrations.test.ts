import { describe, it, expect } from 'vitest';
import { ACK_PATTERN, findDestructiveReasons, statementsOf, stripSqlComments } from '../check-destructive-migrations';

describe('statementsOf', () => {
  it('given a Drizzle-style file, should split on statement-breakpoint markers', () => {
    const sql = 'DROP TABLE "a";--> statement-breakpoint\nDROP TABLE "b";';
    expect(statementsOf(sql)).toEqual(['DROP TABLE "a";', 'DROP TABLE "b";']);
  });

  it('given a single-statement file, should return one statement', () => {
    expect(statementsOf('TRUNCATE "x";')).toEqual(['TRUNCATE "x";']);
  });
});

describe('findDestructiveReasons', () => {
  it('given DROP TABLE, should flag it', () => {
    expect(findDestructiveReasons('DROP TABLE "alert_history";')).toEqual(['DROP TABLE']);
  });

  it('given DROP COLUMN, should flag it', () => {
    expect(findDestructiveReasons('ALTER TABLE "users" DROP COLUMN IF EXISTS "password";')).toEqual([
      'DROP COLUMN',
    ]);
  });

  it('given TRUNCATE, should flag it', () => {
    expect(findDestructiveReasons('TRUNCATE security_audit_log;')).toEqual(['TRUNCATE']);
  });

  it('given DROP TYPE, should flag it', () => {
    expect(findDestructiveReasons('DROP TYPE "WorkflowRunStatus";')).toEqual(['DROP TYPE']);
  });

  it('given an enum-swap rename (RENAME TO ..._old), should flag it', () => {
    expect(
      findDestructiveReasons('ALTER TYPE "WorkflowRunStatus" RENAME TO "WorkflowRunStatus_old";')
    ).toEqual(['enum-swap rename (RENAME TO ..._old)']);
  });

  it('given ALTER COLUMN ... TYPE, should flag it', () => {
    expect(
      findDestructiveReasons(
        'ALTER TABLE "activity_logs" ALTER COLUMN "contentFormat" SET DATA TYPE content_format USING "contentFormat"::content_format;'
      )
    ).toEqual(['ALTER COLUMN ... TYPE (data type change)']);
  });

  it('given ADD COLUMN ... NOT NULL with no DEFAULT, should flag it', () => {
    expect(
      findDestructiveReasons('ALTER TABLE "calendar_triggers" ADD COLUMN "workflowId" text NOT NULL;')
    ).toEqual(['ADD COLUMN ... NOT NULL without a DEFAULT']);
  });

  it('given ADD COLUMN ... NOT NULL with a DEFAULT, should not flag it', () => {
    expect(
      findDestructiveReasons('ALTER TABLE "t" ADD COLUMN "x" boolean DEFAULT false NOT NULL;')
    ).toEqual([]);
  });

  it('given ADD COLUMN ... bigserial NOT NULL, should not flag it (self-populating)', () => {
    expect(
      findDestructiveReasons('ALTER TABLE "activity_logs" ADD COLUMN "chainSeq" bigserial NOT NULL;')
    ).toEqual([]);
  });

  it('given a purely additive statement, should not flag anything', () => {
    expect(findDestructiveReasons('ALTER TABLE "t" ADD COLUMN "x" text;')).toEqual([]);
  });

  it('given multiple destructive statements in one file, should flag each distinct reason once', () => {
    const sql = [
      'TRUNCATE TABLE "calendar_triggers";--> statement-breakpoint',
      'ALTER TABLE "calendar_triggers" DROP COLUMN IF EXISTS "status";--> statement-breakpoint',
      'DROP TYPE "CalendarTriggerStatus";',
    ].join('\n');
    const reasons = findDestructiveReasons(sql);
    expect(reasons).toContain('TRUNCATE');
    expect(reasons).toContain('DROP COLUMN');
    expect(reasons).toContain('DROP TYPE');
    expect(reasons).toHaveLength(3);
  });

  it('given ADD COLUMN NOT NULL with a comment mentioning DEFAULT (not a real one), should still flag it', () => {
    expect(
      findDestructiveReasons(
        '-- table is empty, so no DEFAULT is needed\nALTER TABLE "t" ADD COLUMN "x" text NOT NULL;'
      )
    ).toEqual(['ADD COLUMN ... NOT NULL without a DEFAULT']);
  });

  it('given ADD COLUMN NOT NULL with a comment mentioning SERIAL (not a real one), should still flag it', () => {
    expect(
      findDestructiveReasons(
        '-- not a serial column, just named that way\nALTER TABLE "t" ADD COLUMN "x" text NOT NULL;'
      )
    ).toEqual(['ADD COLUMN ... NOT NULL without a DEFAULT']);
  });

  it('given a real DROP TABLE only inside a comment, should not flag it', () => {
    expect(findDestructiveReasons('-- old code used to DROP TABLE "x" here, no longer true\nSELECT 1;')).toEqual(
      []
    );
  });
});

describe('stripSqlComments', () => {
  it('given a line comment, should remove it', () => {
    expect(stripSqlComments('-- a comment\nDROP TABLE "x";')).toBe('\nDROP TABLE "x";');
  });

  it('given a block comment, should remove it', () => {
    expect(stripSqlComments('/* a block comment */ DROP TABLE "x";')).toBe(' DROP TABLE "x";');
  });

  it('given a multi-line block comment, should remove it', () => {
    expect(stripSqlComments('/* line one\nline two */\nDROP TABLE "x";')).toBe('\nDROP TABLE "x";');
  });

  it('given no comments, should return the input unchanged', () => {
    expect(stripSqlComments('DROP TABLE "x";')).toBe('DROP TABLE "x";');
  });
});

describe('ACK_PATTERN', () => {
  it('given a destructive-migration-ack comment, should match', () => {
    expect(ACK_PATTERN.test('-- destructive-migration-ack: no old code reads this table\nDROP TABLE "x";')).toBe(
      true
    );
  });

  it('given an ack comment with no reason text, should not match', () => {
    expect(ACK_PATTERN.test('-- destructive-migration-ack:\nDROP TABLE "x";')).toBe(false);
  });

  it('given no ack comment, should not match', () => {
    expect(ACK_PATTERN.test('DROP TABLE "x";')).toBe(false);
  });

  it('given an unrelated comment, should not match', () => {
    expect(ACK_PATTERN.test('-- this table is old\nDROP TABLE "x";')).toBe(false);
  });
});
