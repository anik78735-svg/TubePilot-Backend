const axios = require('axios');

const GRAPH_VERSION = 'v19.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const META_REDIRECT_URI = process.env.META_REDIRECT_URI;

const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts'
].join(',');

const logMetaError = (label, err) => {
  const graphError = err.response?.data?.error;
  if (graphError) {
    console.error(`❌ [Meta:${label}] Graph API error:`, JSON.stringify(graphError, null, 2));
  } else {
    console.error(`❌ [Meta:${label}] Non-Graph error:`, err.message);
  }
};

const getFacebookOAuthUrl = (state) => {
  const params = new URLSearchParams({
    client_id: META_APP_ID,
    redirect_uri: META_REDIRECT_URI,
    state,
    scope: META_SCOPES,
    response_type: 'code'
  });
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
};

const exchangeCodeForToken = async (code) => {
  try {
    const res = await axios.get(`${GRAPH_BASE}/oauth/access_token`, {
      params: { client_id: META_APP_ID, redirect_uri: META_REDIRECT_URI, client_secret: META_APP_SECRET, code }
    });
    console.log('✅ [Meta:exchangeCodeForToken] Got short-lived token');
    return res.data.access_token;
  } catch (err) {
    logMetaError('exchangeCodeForToken', err);
    throw err;
  }
};

const getLongLivedUserToken = async (shortLivedToken) => {
  try {
    const res = await axios.get(`${GRAPH_BASE}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: META_APP_ID,
        client_secret: META_APP_SECRET,
        fb_exchange_token: shortLivedToken
      }
    });
    console.log('✅ [Meta:getLongLivedUserToken] Got long-lived token');
    return res.data.access_token;
  } catch (err) {
    logMetaError('getLongLivedUserToken', err);
    throw err;
  }
};

const getUserPages = async (userAccessToken) => {
  try {
    const res = await axios.get(`${GRAPH_BASE}/me/accounts`, {
      params: { access_token: userAccessToken, fields: 'id,name,access_token' }
    });
    const pages = res.data.data || [];
    console.log(`✅ [Meta:getUserPages] Found ${pages.length} page(s):`, pages.map((p) => p.name).join(', ') || '(none)');
    return pages;
  } catch (err) {
    logMetaError('getUserPages', err);
    throw err;
  }
};

// Polls a Facebook video's processing status after the "finish" upload
// phase. The finish call returns success as soon as Facebook has ACCEPTED
// the video_url, NOT once it has finished downloading/processing it from
// that URL — Facebook fetches the video in the background. If we delete our
// temporary storage copy before that fetch completes, the Reel ends up
// broken ("This page isn't available"). This poll makes sure Facebook has
// actually finished downloading and processing before we report success.
//
// NOTE: the `status` object Facebook returns is nested, e.g.:
//   {
//     video_status: 'processing',
//     uploading_phase: { status: 'in_progress', bytes_transfered: 50002 },
//     processing_phase: { status: 'not_started' },
//     publishing_phase: { status: 'not_started' }
//   }
// We return the whole object so callers can inspect the sub-phases (not
// just the top-level video_status) for diagnostics.
const getFacebookVideoStatus = async (videoId, pageAccessToken) => {
  const res = await axios.get(`${GRAPH_BASE}/${videoId}`, {
    params: { fields: 'status', access_token: pageAccessToken }
  });
  return res.data.status; // { video_status, uploading_phase, processing_phase, publishing_phase }
};

const publishFacebookReel = async ({ pageId, pageAccessToken, videoUrl, caption }) => {
  try {
    console.log(`▶️ [Meta:publishFacebookReel] Starting for page ${pageId}, video: ${videoUrl}`);
    const startRes = await axios.post(`${GRAPH_BASE}/${pageId}/video_reels`, null, {
      params: { upload_phase: 'start', access_token: pageAccessToken }
    });
    const videoId = startRes.data.video_id;
    console.log(`ℹ️ [Meta:publishFacebookReel] Upload session started, video_id=${videoId}`);

    const finishRes = await axios.post(`${GRAPH_BASE}/${videoId}`, null, {
      params: {
        upload_phase: 'finish',
        video_url: videoUrl,
        description: caption || '',
        video_state: 'PUBLISHED',
        access_token: pageAccessToken
      }
    });
    console.log(`ℹ️ [Meta:publishFacebookReel] Finish accepted:`, JSON.stringify(finishRes.data));

    // Wait for Facebook to actually finish fetching + processing the video
    // from our URL before reporting success — this is what protects the
    // temp file from being deleted too early. Real-world processing for
    // longer/larger Reels regularly runs past 3 minutes while Facebook
    // keeps reporting video_status=uploading, so we poll for up to ~8
    // minutes total, checking less frequently once the wait gets long
    // (fewer Graph API calls without slowing down the common fast case).
    const maxWaitMs = 8 * 60 * 1000; // 8 minutes
    const startedAt = Date.now();
    let attempt = 0;

    // If Facebook's fetch of our video_url stalls completely (no upload
    // progress for several consecutive polls), waiting out the full 8
    // minutes just to time out anyway is wasted effort — this pattern
    // (video_status stuck at "uploading" with no byte progress) usually
    // means Facebook can't actually reach/read our video_url. We fail
    // fast with a clearer diagnosis instead of a generic timeout, so this
    // is distinguishable in logs/retries from a video that is genuinely
    // still (slowly) processing.
    const STUCK_POLL_THRESHOLD = 6;
    let lastBytesTransfered = -1;
    let stuckPollCount = 0;

    while (Date.now() - startedAt < maxWaitMs) {
      attempt += 1;
      const status = await getFacebookVideoStatus(videoId, pageAccessToken);
      const videoStatus = status?.video_status;
      const uploadingPhase = status?.uploading_phase;
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      console.log(`ℹ️ [Meta:publishFacebookReel] Poll ${attempt} (${elapsedSec}s elapsed): video_status=${videoStatus} full_status=${JSON.stringify(status)}`);

      if (videoStatus === 'ready') {
        console.log(`✅ [Meta:publishFacebookReel] Video fully processed and ready after ${elapsedSec}s`);
        return { platformPostId: videoId, platformUrl: `https://www.facebook.com/reel/${videoId}` };
      }
      if (videoStatus === 'error') {
        throw new Error(`Facebook failed to process the video: ${JSON.stringify(status)}`);
      }

      // Track whether Facebook is actually receiving bytes from our
      // video_url. If it's still in the uploading phase and
      // bytes_transfered hasn't moved for several polls in a row,
      // Facebook is stuck fetching from our URL (network/CDN/access
      // issue) and will not finish on its own — fail fast instead of
      // burning the full timeout.
      if (uploadingPhase && typeof uploadingPhase.bytes_transfered === 'number') {
        if (uploadingPhase.bytes_transfered === lastBytesTransfered) {
          stuckPollCount += 1;
        } else {
          stuckPollCount = 0;
          lastBytesTransfered = uploadingPhase.bytes_transfered;
        }
        if (stuckPollCount >= STUCK_POLL_THRESHOLD) {
          throw new Error(
            `Facebook appears stuck fetching the video from video_url (no upload progress for ${stuckPollCount} consecutive polls, stuck at ${lastBytesTransfered} bytes transferred). Check that the video URL is publicly reachable by Facebook's servers.`
          );
        }
      }

      // Poll every 5s for the first 3 minutes, then back off to every 15s.
      const interval = elapsedSec < 180 ? 5000 : 15000;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error('Facebook video processing timed out (still not ready after 8 minutes)');
  } catch (err) {
    logMetaError('publishFacebookReel', err);
    throw err;
  }
};

module.exports = {
  getFacebookOAuthUrl,
  exchangeCodeForToken,
  getLongLivedUserToken,
  getUserPages,
  publishFacebookReel
};
