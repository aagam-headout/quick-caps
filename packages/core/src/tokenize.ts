import { encode } from 'gpt-tokenizer';

/**
 * Real BPE token count (cl100k-family, via gpt-tokenizer) of a string — what
 * actually costs an agent's context window. distill.ts enforces its token
 * budget against this, not a chars/4 guess, per the spec's acceptance
 * criterion: a measured number, not a judgement call.
 */
export function countTokens(text: string): number {
  return encode(text).length;
}
