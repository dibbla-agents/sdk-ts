/**
 * Simple utility functions - greeting and math operations
 */

import * as sdk from '../../src/index';
import { z } from 'zod';

// ============================================================================
// GREETING FUNCTION
// ============================================================================

const GreetingInput = z.object({
  name: z.string().describe('Name to greet'),
});

const GreetingOutput = z.object({
  message: z.string().describe('The greeting message'),
});

export const greetingFn = sdk.newSimpleFunction({
  name: 'greeting',
  version: '1.0.0',
  description: 'Generate a greeting message',
  input: GreetingInput,
  output: GreetingOutput,
  handler: (input) => ({
    message: `Hello, ${input.name}!`,
  }),
  tags: ['utility', 'greeting'],
});

// ============================================================================
// ADD NUMBERS FUNCTION
// ============================================================================

const AddNumbersInput = z.object({
  a: z.number().describe('First number'),
  b: z.number().describe('Second number'),
});

const AddNumbersOutput = z.object({
  result: z.number().describe('Sum of a and b'),
});

export const addNumbersFn = sdk.newSimpleFunction({
  name: 'add_numbers',
  version: '1.0.0',
  description: 'Add two numbers together',
  input: AddNumbersInput,
  output: AddNumbersOutput,
  handler: (input) => ({
    result: input.a + input.b,
  }),
  tags: ['utility', 'math'],
});

