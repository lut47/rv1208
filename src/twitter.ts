import { resolveAfter } from "./shared";

type Attachment = {
    type: "photo" | "video";
    url: URL;
};

export type Tweet = {
    id: string;
    createdAt: number;
    text: string;
    attachments: Attachment[];
};

export const pollTweets = async (
    userId: string,
    delayInMs: number,
    fromTime: number,
    handleTweet: (tweet: Tweet) => void,
) => {
    let stopped = false;

    while (!stopped) {
        await resolveAfter(delayInMs);
        const latestPosts = (await fetchTweets(userId)).sort(
            (a, b) => b.createdAt - a.createdAt,
        );
        for (const post of latestPosts)
            if (post.createdAt > fromTime) handleTweet(post);
        fromTime = latestPosts[0]?.createdAt ?? Date.now();
    }

    return () => (stopped = true);
};

const getTweetsUrl = (userId: string) =>
    `https://x.com/i/api/graphql/SXVCYB8XHSS25nzIljNtZA/UserTweets?variables=%7B%22userId%22%3A%22${userId}%22%2C%22count%22%3A20%2C%22includePromotedContent%22%3Atrue%2C%22withQuickPromoteEligibilityTweetFields%22%3Atrue%2C%22withVoice%22%3Atrue%7D&features=%7B%22rweb_video_screen_enabled%22%3Afalse%2C%22rweb_cashtags_enabled%22%3Atrue%2C%22profile_label_improvements_pcf_label_in_post_enabled%22%3Atrue%2C%22responsive_web_profile_redirect_enabled%22%3Atrue%2C%22rweb_tipjar_consumption_enabled%22%3Afalse%2C%22verified_phone_label_enabled%22%3Afalse%2C%22creator_subscriptions_tweet_preview_api_enabled%22%3Atrue%2C%22responsive_web_graphql_timeline_navigation_enabled%22%3Atrue%2C%22premium_content_api_read_enabled%22%3Afalse%2C%22communities_web_enable_tweet_community_results_fetch%22%3Atrue%2C%22c9s_tweet_anatomy_moderator_badge_enabled%22%3Atrue%2C%22responsive_web_grok_analyze_button_fetch_trends_enabled%22%3Afalse%2C%22responsive_web_grok_analyze_post_followups_enabled%22%3Atrue%2C%22rweb_cashtags_composer_attachment_enabled%22%3Atrue%2C%22responsive_web_jetfuel_frame%22%3Atrue%2C%22responsive_web_grok_share_attachment_enabled%22%3Atrue%2C%22responsive_web_grok_annotations_enabled%22%3Atrue%2C%22articles_preview_enabled%22%3Atrue%2C%22responsive_web_edit_tweet_api_enabled%22%3Atrue%2C%22rweb_conversational_replies_downvote_enabled%22%3Afalse%2C%22graphql_is_translatable_rweb_tweet_is_translatable_enabled%22%3Atrue%2C%22view_counts_everywhere_api_enabled%22%3Atrue%2C%22longform_notetweets_consumption_enabled%22%3Atrue%2C%22responsive_web_twitter_article_tweet_consumption_enabled%22%3Atrue%2C%22content_disclosure_indicator_enabled%22%3Atrue%2C%22content_disclosure_ai_generated_indicator_enabled%22%3Atrue%2C%22responsive_web_grok_show_grok_translated_post%22%3Atrue%2C%22responsive_web_grok_analysis_button_from_backend%22%3Atrue%2C%22post_ctas_fetch_enabled%22%3Afalse%2C%22freedom_of_speech_not_reach_fetch_enabled%22%3Atrue%2C%22standardized_nudges_misinfo%22%3Atrue%2C%22tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled%22%3Atrue%2C%22longform_notetweets_rich_text_read_enabled%22%3Atrue%2C%22longform_notetweets_inline_media_enabled%22%3Afalse%2C%22responsive_web_grok_image_annotation_enabled%22%3Atrue%2C%22responsive_web_grok_imagine_annotation_enabled%22%3Atrue%2C%22responsive_web_grok_community_note_auto_translation_is_enabled%22%3Atrue%2C%22responsive_web_enhance_cards_enabled%22%3Afalse%7D&fieldToggles=%7B%22withArticlePlainText%22%3Afalse%7D`;

const authorizationHeaders = JSON.parse(
    process.env.TWITTER_AUTHORIZATION_HEADERS!,
);

export const fetchTweets = async (userId: string) => {
    const response = await fetch(getTweetsUrl(userId), {
        headers: authorizationHeaders,
        method: "GET",
    });
    return parseGraphQLResponse(await response.json());
};

const parseGraphQLResponse = (value: any): Tweet[] =>
    value.data.user.result.timeline.timeline.instructions
        .filter(({ type }: any) => type === "TimelineAddEntries")
        .flatMap(({ entries }: any) =>
            entries.map(
                ({ content }: any) =>
                    content.__typename === "TimelineTimelineItem" &&
                    parseTweet(content.itemContent.tweet_results.result),
            ),
        )
        .filter(Boolean);

const applyTextRange = (text: string, range: [number, number]) =>
    text.substring(range[0], range[1]);

const unpackTweetResultWithVisibility = (tweetResult: any) =>
    tweetResult.__typename === "TweetWithVisibilityResults"
        ? tweetResult.tweet.legacy
        : tweetResult.legacy;

const parseMediaEntities = (mediaEntities: any[]) =>
    (mediaEntities
        ?.map((item: any) => {
            const isVideo = item.type === "video";
            if (!isVideo && item.type !== "photo") return;
            return {
                type: item.type,
                url: new URL(
                    isVideo
                        ? item.video_info.variants.at(-1).url
                        : item.media_url_https,
                ),
            };
        })
        ?.filter(Boolean) ?? []) as Attachment[];

const parseTweet = (tweetResult: any): Tweet => {
    const { id_str: id, ...dto } = unpackTweetResultWithVisibility(tweetResult);
    const createdAt = new Date(dto.created_at as string).getTime();

    if (dto.retweeted_status_result)
        return {
            ...parseTweet(dto.retweeted_status_result.result),
            id,
            createdAt,
        };

    const text = applyTextRange(dto.full_text, dto.display_text_range);
    const attachments = parseMediaEntities(dto.entities?.media ?? []);

    if (dto.quoted_status_result) {
        const quotedTweet = unpackTweetResultWithVisibility(
            dto.quoted_status_result.result,
        );
        console.log(quotedTweet, text, attachments);
        return {
            id,
            createdAt,
            text: `"${applyTextRange(quotedTweet.full_text, quotedTweet.display_text_range)}"\n\n${text}`,
            attachments: attachments.concat(
                parseMediaEntities(quotedTweet.entities?.media ?? []),
            ),
        };
    }

    return {
        id,
        createdAt,
        text: dto.quoted_status_permalink
            ? `${dto.quoted_status_permalink.expanded.replace(/(twitter.com)|(x.com)/, "fxtwitter.com")}\n\n${text}`
            : text,
        attachments,
    };
};
