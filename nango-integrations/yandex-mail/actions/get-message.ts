import { createAction } from 'nango';

import {
    BRIDGE_PATHS,
    callMailBridge,
    getMessageInputSchema,
    getMessageOutputSchema
} from '../lib/bridge.js';

const action = createAction({
    description: 'Fetch one bounded message and attachment metadata from the configured Yandex Mail mailbox.',
    version: '1.0.0',
    scopes: ['mail:imap_full'],
    input: getMessageInputSchema,
    output: getMessageOutputSchema,
    exec: async (nango, input) =>
        callMailBridge({
            nango,
            path: BRIDGE_PATHS.getMessage,
            payload: getMessageInputSchema.parse(input),
            output: getMessageOutputSchema,
            mutating: false
        })
});

export default action;
