import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { requireRole } from './auth.js';

describe('requireRole', () => {
  it('passes for an allowed role', () => {
    expect(() => requireRole('start_run', 'orchestrator', 'orchestrator')).not.toThrow();
  });

  it('passes when the role is one of several allowed roles', () => {
    expect(() => requireRole('t', 'reviewer', 'implementer', 'reviewer')).not.toThrow();
  });

  it('throws a readable McpError for a forbidden role', () => {
    expect(() => requireRole('start_run', 'reviewer', 'orchestrator')).toThrow(McpError);
    expect(() => requireRole('start_run', 'reviewer', 'orchestrator')).toThrow(
      'tool start_run is not allowed for role reviewer (allowed: orchestrator)',
    );
  });

  it('throws when no role is allowed', () => {
    expect(() => requireRole('t', 'reviewer')).toThrow(McpError);
  });
});
