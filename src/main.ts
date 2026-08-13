import {
    InputMedia,
    MemoryStorage,
    Message,
    TelegramClient,
} from "@mtcute/bun";
import { logWithTime, resolveAfter } from "./shared";
import { fetchTweets, pollTweets, type Tweet } from "./twitter";

const sourceTwitterProfileId = "1642521833973981184";
const sourceTgChannelId = -1004429239095;
const targetTgChannelId = -1003943671255;

const messageGroupAccumulationTimeoutMs = 1000;
const _messageGroupCollectionTimeoutS =
    messageGroupAccumulationTimeoutMs / 1000;
const backfillDelayMs = 1000;
const _backfillDelayS = backfillDelayMs / 1000;
const twitterPostPollingDelayInMs = 30_000;

const doBackfill = process.env.BACKFILL === "true";

const createAsyncKeyedAccumulator = <K, T>(
    timeout: number,
    handleCollected: (key: K, values: T[]) => void,
) => ({
    groups: new Map<K, T[]>(),
    async add(key: K, value: T) {
        let values: T[];
        if (this.groups.has(key)) (values = this.groups.get(key)!).push(value);
        else this.groups.set(key, (values = [value]));
        const prevLength = values.length;
        await resolveAfter(timeout);
        if (values.length === prevLength) return handleCollected(key, values);
    },
});

const messageGroupAccumulator = createAsyncKeyedAccumulator<string, Message>(
    messageGroupAccumulationTimeoutMs,
    async (groupId, messages) => {
        await tg.sendCopyGroup({
            toChatId: targetTgChannelId,
            messages,
        });
        logWithTime(`telegram post ${groupId} (message group) has been copied`);
    },
);

const copyTwitterPost = (post: Tweet) =>
    post.attachments.length
        ? tg.sendMediaGroup(
              targetTgChannelId,
              post.attachments.map((attachment) =>
                  attachment.type === "photo"
                      ? InputMedia.photo(attachment.url)
                      : InputMedia.video(attachment.url),
              ),
          )
        : tg.sendText(targetTgChannelId, post.text);

const tg = new TelegramClient({
    apiId: Number(process.env.TG_API_ID),
    apiHash: process.env.TG_API_HASH!,
    storage: new MemoryStorage(),
});

logWithTime("connecting to telegram");
if (!process.env.TG_SESSION) {
    await tg.start();
    logWithTime("use this for TG_SESSION environment variable:");
    console.log(await tg.exportSession());
} else await tg.start({ session: process.env.TG_SESSION, sessionForce: true });
logWithTime("connected to telegram");

logWithTime("fetching the latest copied post date");
const targetChannelMessages = doBackfill
    ? await tg.getHistory(targetTgChannelId, { limit: 1 })
    : [];
const fromTime = targetChannelMessages[0]?.date.getTime() ?? 0;
logWithTime(
    `the latest copied post date has been fetched (if any, ${fromTime})`,
);

if (doBackfill) {
    logWithTime("backfilling telegram posts");
    const sourceChannelMessages = await tg.getHistory(sourceTgChannelId, {
        limit: 100,
    });
    logWithTime("latest telegram posts have been fetched");
    const latestSourceTelegramChannelMessages = [...sourceChannelMessages].sort(
        (a, b) => a.date.getTime() - b.date.getTime(),
    );
    const missingMessageGroups = new Map<string, Message[]>();
    for (const message of latestSourceTelegramChannelMessages) {
        if (message.date.getTime() <= fromTime) continue;
        if (message.groupedId) {
            const groupId = message.groupedId.toString();
            const group = missingMessageGroups.get(groupId);
            if (group) group.push(message);
            else missingMessageGroups.set(groupId, [message]);
            continue;
        }
        logWithTime(`copying telegram post ${message.id}`);
        await tg.sendCopy({ toChatId: targetTgChannelId, message });
        logWithTime(`telegram post ${message.id} has been copied`);
        logWithTime(
            `(waiting ${_backfillDelayS}s to prevent flood block from telegram)`,
        );
        await resolveAfter(backfillDelayMs);
    }
    for (const [groupId, messages] of missingMessageGroups) {
        logWithTime(`copying telegram post ${groupId} (message group)`);
        await tg.sendCopyGroup({ toChatId: targetTgChannelId, messages });
        logWithTime(`telegram post ${groupId} (message group) has been copied`);
    }
    logWithTime("backfilled telegram posts (if any)");

    logWithTime("backfilling tweets");
    const latestSourceTwitterProfilePosts = (
        await fetchTweets(sourceTwitterProfileId)
    ).sort((a, b) => a.createdAt - b.createdAt);
    logWithTime("latest tweets has been fetched");
    for (const post of latestSourceTwitterProfilePosts)
        if (post.createdAt > fromTime) {
            logWithTime(`copying tweet ${post.id}`);
            await copyTwitterPost(post);
            logWithTime(`tweet ${post.id} has been copied`);
            logWithTime(
                `(waiting ${_backfillDelayS}s to prevent flood block from telegram)`,
            );
            await resolveAfter(backfillDelayMs);
        }
    logWithTime("backfilled tweets (if any)");
}

tg.onNewMessage.add(async (message) => {
    if (message.chat.id !== sourceTgChannelId) return;
    if (message.groupedId) {
        const groupId = message.groupedId.toString();
        logWithTime(
            `polled new telegram post part ${message.id} (message group ${groupId}): ${message.text || "(no text)"}`,
        );
        logWithTime(
            `(waiting ${_messageGroupCollectionTimeoutS}s for more messages of message group ${groupId})`,
        );
        await messageGroupAccumulator.add(groupId, message);
    }
    logWithTime(
        `polled new telegram post ${message.id}: ${message.text || "(no text)"}`,
    );
    logWithTime(`copying telegram post ${message.id}`);
    await tg.sendCopy({ toChatId: targetTgChannelId, message });
    logWithTime(`telegram post ${message.id} has been copied`);
});

pollTweets(
    sourceTwitterProfileId,
    twitterPostPollingDelayInMs,
    fromTime,
    async (tweet) => {
        logWithTime(
            `polled new tweet ${tweet.id}: ${tweet.text || "(no text)"}`,
        );
        logWithTime(`copying tweet ${tweet.id}`);
        if (tweet.attachments.length)
            await tg.sendMediaGroup(
                targetTgChannelId,
                tweet.attachments.map((attachment) =>
                    attachment.type === "photo"
                        ? InputMedia.photo(attachment.url)
                        : InputMedia.video(attachment.url),
                ),
            );
        else await tg.sendText(targetTgChannelId, tweet.text);
        logWithTime(`tweet ${tweet.id} has been copied`);
    },
);
