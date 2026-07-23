import { createHash, createHmac } from 'node:crypto';

const CONTENT_TYPE = 'application/json';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export const AMOJO_ORIGINS = {
    ru: 'https://amojo.amocrm.ru',
    com: 'https://amojo.amocrm.com'
} as const;

function twoDigits(value: number): string {
    return String(value).padStart(2, '0');
}

export function formatRfc2822Date(date: Date): string {
    if (Number.isNaN(date.getTime())) {
        throw new Error('Cannot sign an amoCRM Chats request with an invalid date');
    }

    return [
        `${WEEKDAYS[date.getUTCDay()]},`,
        twoDigits(date.getUTCDate()),
        MONTHS[date.getUTCMonth()],
        date.getUTCFullYear(),
        `${twoDigits(date.getUTCHours())}:${twoDigits(date.getUTCMinutes())}:${twoDigits(date.getUTCSeconds())}`,
        '+0000'
    ].join(' ');
}

export function signAmoChatsRequest(input: {
    body: string;
    path: string;
    secret: string;
    date: Date;
}): {
    contentMd5: string;
    canonical: string;
    signature: string;
    headers: Record<string, string>;
} {
    const date = formatRfc2822Date(input.date);
    const contentMd5 = createHash('md5').update(input.body, 'utf8').digest('hex');
    const canonical = ['POST', contentMd5, CONTENT_TYPE, date, input.path].join('\n');
    const signature = createHmac('sha1', input.secret).update(canonical, 'utf8').digest('hex');

    return {
        contentMd5,
        canonical,
        signature,
        headers: {
            Date: date,
            'Content-Type': CONTENT_TYPE,
            'Content-MD5': contentMd5,
            'X-Signature': signature
        }
    };
}
