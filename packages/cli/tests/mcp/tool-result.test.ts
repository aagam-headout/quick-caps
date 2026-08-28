import { describe, expect, it } from 'vitest';
import { textResult, errorResult, toToolResult } from '../../src/mcp/tool-result.js';
import { CliError } from '../../src/errors.js';
import { SessionNotFoundError } from '../../src/session.js';

describe('textResult', () => {
  it('wraps a string in MCP content shape', () => {
    expect(textResult('hello')).toEqual({ content: [{ type: 'text', text: 'hello' }] });
  });
});

describe('errorResult', () => {
  it('surfaces a CliError message with isError true', () => {
    expect(errorResult(new CliError('bad handle'))).toEqual({
      content: [{ type: 'text', text: 'bad handle' }],
      isError: true,
    });
  });

  it('surfaces a SessionNotFoundError message with isError true', () => {
    const err = new SessionNotFoundError('/tmp/x');
    expect(errorResult(err)).toEqual({ content: [{ type: 'text', text: err.message }], isError: true });
  });

  it('stringifies a non-Error throw', () => {
    expect(errorResult('boom')).toEqual({ content: [{ type: 'text', text: 'boom' }], isError: true });
  });
});

describe('toToolResult', () => {
  it('returns a text result on success', async () => {
    const result = await toToolResult(async () => 'ok');
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });

  it('returns an error result when run() throws', async () => {
    const result = await toToolResult(async () => {
      throw new CliError('nope');
    });
    expect(result).toEqual({ content: [{ type: 'text', text: 'nope' }], isError: true });
  });
});
