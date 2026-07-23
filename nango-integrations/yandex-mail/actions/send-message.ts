import { createAction } from 'nango';

import {
    BRIDGE_PATHS,
    callMailBridge,
    sendMessageInputSchema,
    sendMessageOutputSchema
} from '../lib/bridge.js';

const action = createAction({
    description: 'Send one bounded message through the configured Yandex Mail mailbox.',
    version: '1.0.0',
    scopes: ['mail:smtp'],
    input: sendMessageInputSchema,
    output: sendMessageOutputSchema,
    exec: async (nango, input) =>
        callMailBridge({
            nango,
            path: BRIDGE_PATHS.sendMessage,
            payload: sendMessageInputSchema.parse(input),
            output: sendMessageOutputSchema,
            mutating: true
        })
});

export default action;
