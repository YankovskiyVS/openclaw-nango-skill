import { createAction } from 'nango';

import {
    BRIDGE_PATHS,
    callMailBridge,
    resolveMailboxInputSchema,
    resolveMailboxOutputSchema
} from '../lib/bridge.js';

const action = createAction({
    description: 'Validate the configured Yandex Mail mailbox through the trusted mail bridge.',
    version: '1.0.0',
    scopes: ['mail:imap_full'],
    input: resolveMailboxInputSchema,
    output: resolveMailboxOutputSchema,
    exec: async (nango, input) =>
        callMailBridge({
            nango,
            path: BRIDGE_PATHS.resolveMailbox,
            payload: resolveMailboxInputSchema.parse(input),
            output: resolveMailboxOutputSchema,
            mutating: false
        })
});

export default action;
