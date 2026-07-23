import { createAction } from 'nango';

import {
    BRIDGE_PATHS,
    callMailBridge,
    listMessagesInputSchema,
    listMessagesOutputSchema
} from '../lib/bridge.js';

const action = createAction({
    description: 'List a bounded set of messages from the configured Yandex Mail mailbox.',
    version: '1.0.0',
    scopes: ['mail:imap_full'],
    input: listMessagesInputSchema,
    output: listMessagesOutputSchema,
    exec: async (nango, input) =>
        callMailBridge({
            nango,
            path: BRIDGE_PATHS.listMessages,
            payload: listMessagesInputSchema.parse(input),
            output: listMessagesOutputSchema,
            mutating: false
        })
});

export default action;
