/**
 * Example: Advanced Worker using the Dibbla SDK for TypeScript
 * 
 * This example demonstrates how to create a worker with advanced functions
 * that use global state services (cache, store, OAuth, status messages).
 * 
 * To run:
 * 1. Set environment variables (or use .env file):
 *    - SERVER_API_TOKEN=your-api-token
 *    - SERVER_NAME=my-worker (optional)
 *    - GRPC_SERVER_ADDRESS=grpc.dibbla.com:443 (optional, this is the default)
 * 
 * 2. Run: npx ts-node examples/advanced-worker.ts
 */

import * as sdk from '../src/index';
import { z } from '../src/index';

// Define schemas for a function that demonstrates status messages
const LongRunningTaskInput = z.object({
  steps: z.number().min(1).max(10).describe('Number of steps to simulate'),
  stepDelayMs: z.number().min(100).max(5000).default(1000).describe('Delay between steps in ms'),
});

const LongRunningTaskOutput = z.object({
  completedSteps: z.number().describe('Number of steps completed'),
  totalTimeMs: z.number().describe('Total time taken in milliseconds'),
});

// Define schemas for a function that uses caching
const ExpensiveCalculationInput = z.object({
  value: z.number().describe('Input value for calculation'),
});

const ExpensiveCalculationOutput = z.object({
  result: z.number().describe('Calculated result'),
  cached: z.boolean().describe('Whether the result was from cache'),
});

// Define schemas for a function that stores data
const StoreDataInput = z.object({
  key: z.string().describe('Key to store data under'),
  value: z.string().describe('Value to store'),
});

const StoreDataOutput = z.object({
  success: z.boolean().describe('Whether the store operation succeeded'),
  key: z.string().describe('The key that was used'),
});

// Define schemas for a function that retrieves stored data
const GetDataInput = z.object({
  key: z.string().describe('Key to retrieve data from'),
});

const GetDataOutput = z.object({
  value: z.string().nullable().describe('Retrieved value or null if not found'),
  found: z.boolean().describe('Whether the key was found'),
});

// Define schemas for OAuth token retrieval
const GetGoogleTokenInput = z.object({
  // No input needed, uses run context
});

const GetGoogleTokenOutput = z.object({
  accessToken: z.string().describe('The OAuth access token'),
  expiresAt: z.number().describe('Token expiration timestamp'),
});

async function main() {
  const server = sdk.create({
    serverName: process.env.SERVER_NAME || 'ts-advanced-worker',
    serverApiToken: process.env.SERVER_API_TOKEN,
  });

  // Function with caching enabled
  const expensiveCalculationFn = sdk.newFunction({
    name: 'expensive_calculation',
    version: '1.0.0',
    description: 'Perform an expensive calculation with caching',
    input: ExpensiveCalculationInput,
    output: ExpensiveCalculationOutput,
    cacheTTLMs: 5 * 60 * 1000, // 5 minutes
    handler: async (input, event, state) => {
      // Send status message before starting calculation
      await state.rpc?.sendStatusEvent(event, 'Starting expensive calculation...', { 
        inputValue: input.value 
      });

      // Simulate expensive calculation
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const result = input.value * 2;

      // Send completion status message
      await state.rpc?.sendStatusEvent(event, 'Calculation complete!', { 
        inputValue: input.value,
        result 
      });

      return {
        result,
        cached: false, // Will be true if served from cache
      };
    },
    tags: ['calculation', 'cached'],
  });

  // Function that stores data
  const storeDataFn = sdk.newFunction({
    name: 'store_data',
    version: '1.0.0',
    description: 'Store a key-value pair in the workflow store',
    input: StoreDataInput,
    output: StoreDataOutput,
    handler: async (input, event, state) => {
      try {
        await state.store?.setString(event.workflow, input.key, input.value);
        return {
          success: true,
          key: input.key,
        };
      } catch (err) {
        console.error('Failed to store data:', err);
        return {
          success: false,
          key: input.key,
        };
      }
    },
    tags: ['storage'],
  });

  // Function that retrieves stored data
  const getDataFn = sdk.newFunction({
    name: 'get_data',
    version: '1.0.0',
    description: 'Retrieve a value from the workflow store',
    input: GetDataInput,
    output: GetDataOutput,
    handler: async (input, event, state) => {
      try {
        const value = await state.store?.getString(event.workflow, input.key);
        return {
          value: value ?? null,
          found: value !== null,
        };
      } catch (err) {
        console.error('Failed to get data:', err);
        return {
          value: null,
          found: false,
        };
      }
    },
    tags: ['storage'],
  });

  // Function that gets OAuth token
  const getGoogleTokenFn = sdk.newFunction({
    name: 'get_google_token',
    version: '1.0.0',
    description: 'Get a Google OAuth access token for the current user',
    input: GetGoogleTokenInput,
    output: GetGoogleTokenOutput,
    handler: async (_input, event, state) => {
      const token = await state.oauth?.getAccessToken('google', event.run);
      if (!token) {
        throw new Error('Failed to get Google token - user may not have connected their account');
      }
      return {
        accessToken: token.accessToken,
        expiresAt: token.expiresAt,
      };
    },
    tags: ['oauth', 'google'],
  });

  // Function that demonstrates sending status messages during execution
  const longRunningTaskFn = sdk.newFunction({
    name: 'long_running_task',
    version: '1.0.0',
    description: 'A long-running task that sends status updates during execution',
    input: LongRunningTaskInput,
    output: LongRunningTaskOutput,
    handler: async (input, event, state) => {
      const startTime = Date.now();
      
      // Send initial status message
      await state.rpc?.sendStatusEvent(event, 'Starting long-running task...', {
        totalSteps: input.steps,
        currentStep: 0,
      });

      for (let step = 1; step <= input.steps; step++) {
        // Simulate work
        await new Promise(resolve => setTimeout(resolve, input.stepDelayMs));
        
        // Send progress update
        await state.rpc?.sendStatusEvent(event, `Completed step ${step} of ${input.steps}`, {
          totalSteps: input.steps,
          currentStep: step,
          progress: Math.round((step / input.steps) * 100),
        });
      }

      // Send completion status
      const totalTimeMs = Date.now() - startTime;
      await state.rpc?.sendStatusEvent(event, 'Task completed successfully!', {
        totalSteps: input.steps,
        completedSteps: input.steps,
        totalTimeMs,
      });

      return {
        completedSteps: input.steps,
        totalTimeMs,
      };
    },
    tags: ['status-demo', 'long-running'],
  });

  server.registerFunction(expensiveCalculationFn);
  server.registerFunction(storeDataFn);
  server.registerFunction(getDataFn);
  server.registerFunction(getGoogleTokenFn);
  server.registerFunction(longRunningTaskFn);

  console.log('Starting advanced worker...');
  await server.start();
}

main().catch(console.error);

