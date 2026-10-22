// dur.io: the page lives on `app://durio/`, and Chromium sends no Referer from a custom
// scheme. The YouTube player refuses to play without one ("Error 153, video player
// configuration error"); YouTube asks apps without a web origin to send their app id as
// `https://<app id>` instead.
import type { Session } from "electron";

/** What the embedded YouTube player sees as the embedding site */
export const EMBED_REFERER = "https://io.github.dakarxyz.durio.desktop/";

const YOUTUBE_EMBEDS = [
  "https://www.youtube.com/embed/*",
  "https://www.youtube-nocookie.com/embed/*",
];

/**
 * Send a Referer with YouTube embeds of the app's session
 * @param ses Session of the app window
 */
export function sendEmbedReferer(ses: Session) {
  ses.webRequest.onBeforeSendHeaders(
    { urls: YOUTUBE_EMBEDS },
    (details, callback) => {
      const requestHeaders = { ...details.requestHeaders };
      if (!requestHeaders.Referer) requestHeaders.Referer = EMBED_REFERER;
      callback({ requestHeaders });
    },
  );
}
