import { describe, expect, it } from 'vitest';
import { openDb } from '../db.js';
import { ackApproval, raiseApproval } from './approval.js';

const input = { repo: 'acme/one', issue: 12, runId: 'plan-5-x', level: 'PBI', title: 'Add login' };

describe('raiseApproval', () => {
  it('stores an open APPROVAL attention on the created issue', () => {
    const db = openDb(':memory:');
    const a = raiseApproval(db, input);
    expect(a).toMatchObject({
      kind: 'APPROVAL',
      summary: '[PBI] Add login',
      issue: 12,
      state: 'open',
      data: { kind: 'APPROVAL', summary: '[PBI] Add login', pr: null },
    });
    expect(db.queryEvents({ repo: 'acme/one', limit: 10 }).events).toHaveLength(1);
  });
});

describe('ackApproval', () => {
  it('answers and acks the approval of the issue in its repository', () => {
    const db = openDb(':memory:');
    const a = raiseApproval(db, input);
    expect(ackApproval(db, 'acme/one', 12)).toBe(1);
    expect(db.getAttention(a.id)?.state).toBe('acked');
  });

  it('is idempotent', () => {
    const db = openDb(':memory:');
    raiseApproval(db, input);
    ackApproval(db, 'acme/one', 12);
    expect(ackApproval(db, 'acme/one', 12)).toBe(0);
  });

  it('leaves the same issue number of another repository open', () => {
    const db = openDb(':memory:');
    const other = raiseApproval(db, { ...input, repo: 'acme/two' });
    expect(ackApproval(db, 'acme/one', 12)).toBe(0);
    expect(db.getAttention(other.id)?.state).toBe('open');
  });

  it('ignores other attention kinds of the issue', () => {
    const db = openDb(':memory:');
    const q = db.insertEvent(
      'dromos',
      'attention',
      { kind: 'QUESTION', summary: 'q', pr: null },
      {
        repo: 'acme/one',
        issue: 12,
      },
    );
    db.insertAttention(q);
    expect(ackApproval(db, 'acme/one', 12)).toBe(0);
    expect(db.getAttention(q.id)?.state).toBe('open');
  });
});
