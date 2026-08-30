const axios = require('axios');

/**
 * Fast Facebook Reel Publisher using direct Graph API resumable sessions
 */
const publishFacebookReel = async ({ pageId, pageAccessToken, videoUrl, caption }) => {
  try {
    console.log(`🚀 [Facebook] Initializing Reel upload session for Page: ${pageId}...`);

    // Step 1: Initialize Resumable Upload Session
    const initRes = await axios.post(
      `https://graph.facebook.com/v19.0/${pageId}/video_reels`,
      null,
      {
        params: {
          upload_phase: 'start',
          access_token: pageAccessToken
        }
      }
    );

    const { video_id, upload_url } = initRes.data;
    console.log(`✅ [Facebook] Upload session started. Video ID: ${video_id}`);

    // Step 2: Directly Transfer Video Stream/Url to Facebook's Upload Endpoint
    // Facebook host URL se directly fetch kar leta hai agar URL directly accessible ho
    await axios.post(
      upload_url,
      null,
      {
        headers: {
          'Authorization': `OAuth ${pageAccessToken}`,
          'file_url': videoUrl // Direct URL pass karne se server side bandwidth save hoti hai
        },
        timeout: 120000 // 2 minutes timeout limit
      }
    );

    console.log(`⬆️ [Facebook] Binary transfer completed. Publishing Reel...`);

    // Step 3: Finish and Publish
    const publishRes = await axios.post(
      `https://graph.facebook.com/v19.0/${pageId}/video_reels`,
      null,
      {
        params: {
          upload_phase: 'finish',
          access_token: pageAccessToken,
          video_id: video_id,
          video_state: 'PUBLISHED',
          description: caption
        }
      }
    );

    console.log(`🎉 [Facebook] Reel Published Successfully! Post ID: ${publishRes.data.success}`);
    return {
      platformPostId: video_id,
      platformUrl: `https://www.facebook.com/reel/${video_id}`
    };

  } catch (err) {
    console.error(`❌ [Facebook] Upload failed:`, err.response?.data || err.message);
    throw new Error(`Facebook Upload Error: ${err.response?.data?.error?.message || err.message}`);
  }
};

module.exports = { publishFacebookReel };
