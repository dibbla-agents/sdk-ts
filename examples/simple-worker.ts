/**
 * Example: Simple Worker using the Dibbla SDK for TypeScript
 * 
 * This example demonstrates how to create a simple worker with custom functions.
 * 
 * To run:
 * 1. Create a .env file with your token:
 *    - SERVER_API_TOKEN=your-api-token
 *    - SERVER_NAME=my-worker (optional)
 *    - GRPC_SERVER_ADDRESS=grpc.dibbla.com:443 (optional, this is the default)
 * 
 * 2. Run: npx ts-node examples/simple-worker.ts
 */

import 'dotenv/config';
import * as sdk from '../src/index';
import { z } from 'zod';

// Define input/output schemas with Zod
const GreetingInput = z.object({
  name: z.string().describe('Name to greet'),
});

const GreetingOutput = z.object({
  message: z.string().describe('The greeting message'),
});

const AddNumbersInput = z.object({
  a: z.number().describe('First number'),
  b: z.number().describe('Second number'),
});

const AddNumbersOutput = z.object({
  result: z.number().describe('Sum of a and b'),
});

async function main() {
  // Create server with minimal configuration
  const server = sdk.create({
    serverName: process.env.SERVER_NAME || 'ts-example-worker',
    serverApiToken: process.env.SERVER_API_TOKEN,
  });

  // Register a simple greeting function
  const greetingFn = sdk.newSimpleFunction({
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

  // Register a simple math function
  const addNumbersFn = sdk.newSimpleFunction({
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

  server.registerFunction(greetingFn);
  server.registerFunction(addNumbersFn);

  // Start server (blocks forever)
  console.log('Starting worker...');
  await server.start();
}

main().catch(console.error);

