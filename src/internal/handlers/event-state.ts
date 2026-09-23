import { EventMessage } from '../../types/events';

/**
 * The invocation fields a reply carries back: what the request named, plus
 * the name this worker serves functions under.
 */
export interface EventState {
  server: string;
  function: string;
  functionServer: string;
  node: string;
  workflow: string;
  version: string;
  run: string;
  correlationId: string;
}

export function createEventState(message: EventMessage, functionServer: string): EventState {
  return {
    server: message.server,
    function: message.function,
    functionServer,
    node: message.node,
    workflow: message.workflow,
    version: message.version,
    run: message.run,
    correlationId: message.correlationId,
  };
}

/** The pseudo-invocation the registration after connect is correlated with. */
export function startupEventState(serverName: string): EventState {
  return {
    server: serverName,
    function: '',
    functionServer: serverName,
    node: '',
    workflow: '',
    version: '',
    run: '',
    correlationId: 'startup',
  };
}

/** The pseudo-invocation of the startup broadcast. */
export function startupBroadcastEventState(serverName: string): EventState {
  return {
    server: serverName,
    function: 'startup',
    functionServer: serverName,
    node: 'startup',
    workflow: 'startup',
    version: '1.0',
    run: 'startup',
    correlationId: 'startup',
  };
}

export interface EventSender {
  sendEvent(event: EventMessage): Promise<void>;
  setMessageHandler(handler: (message: EventMessage) => void): void;
}
