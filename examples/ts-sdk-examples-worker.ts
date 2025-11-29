/**
 * Minimal Worker Entry Point
 * 
 * This example demonstrates how little code is needed to set up a worker
 * when your function definitions are organized in separate modules.
 * 
 * All function definitions are imported from ./functions/ and registered
 * with the server in just a few lines of code.
 * 
 * To run:
 * 1. Create a .env file with your token:
 *    - SERVER_API_TOKEN=your-api-token
 *    - SERVER_NAME=ts-sdk-worker (optional)
 * 
 * 2. Run: npx ts-node examples/ts-sdk-examples-worker.ts
 */

import 'dotenv/config';
import * as sdk from '../src/index';
import * as functions from './functions';

async function main() {
  const server = sdk.create({
    serverName: process.env.SERVER_NAME || 'ts-sdk-examples-worker',
    serverApiToken: process.env.SERVER_API_TOKEN,
  });

  // Register all functions from the functions module
  server.registerFunctions(functions.all);

  console.log(`Starting worker with ${functions.all.length} functions...`);
  await server.start();
}

main().catch(console.error);

