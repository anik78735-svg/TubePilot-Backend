const express = require('express');
const { protect } = require('../middleware/auth');
const User = require('../models/User');
const Video = require('../models/Video');
const {
  getInstagramAccountId,
  publishInstagramReel,
  publishInstagramCarousel,
  publishFacebookReel
} = require('../utils/meta');

const router = express.Router();

// Helper function to handle user upload credits & diamond deductions
const handlePublishCredits = async (user) => {
  // 1. Check free uploads
  if (user.freeUploadsRemaining > 0) {
    user.freeUploadsRemaining -= 1;
    await user.save();
    return { usedFreeUpload: true, diamondsCharged: 0 };
  }

  // 2. Check diamond balance (1 diamond per post/upload)
  const UPLOAD_COST = 1;
  if (user.diamondBalance < UPLOAD_COST) {
    const err = new Error('Insufficient diamonds. Please buy more diamonds to publish.');
    err.code = 'INSUFFICIENT_DIAMONDS';
    throw err;
  }

  user.diamondBalance -= UPLOAD_COST;
  await user.save();
  return { usedFreeUpload: false, diamondsCharged: UPLOAD_COST };
};

// ==========================================
// 1. INSTAGRAM CAROUSEL POST (2 - 10 Items)
// Route: POST /api/posts/instagram/carousel
// ==========================================
router.post('/instagram/carousel', protect, async (req, res) => {
  try {
    const { mediaItems, caption } = req.body;

    // Validate media items length (Meta API constraint: 2 to 10 items)
    if (!Array.isArray(mediaItems) || mediaItems.length < 2 || mediaItems.length > 10) {
      return res.status(400).json({
        success: false,
        message: 'Instagram Carousel requires between 2 and 10 media items.'
      });
    }

    // Validate each item URL
    for (let i = 0; i < mediaItems.length; i++) {
      if (!mediaItems[i]?.url) {
        return res.status(400).json({
          success: false,
          message: `Item at index ${i} is missing a valid media URL.`
        });
      }
    }

    // Check Meta connection
    const connectedFB = req.user.connectedFacebook;
    if (!connectedFB?.pageId || !connectedFB?.pageAccessToken) {
      return res.status(400).json({
        success: false,
        message: 'Facebook Page is not connected. Please connect Meta via OAuth first.'
      });
    }

    // Process diamond/free upload charge
    const creditInfo = await handlePublishCredits(req.user);

    // Fetch linked Instagram Business Account ID
    const igUserId = await getInstagramAccountId(connectedFB.pageId, connectedFB.pageAccessToken);

    // Call Meta helper function
    console.log(`▶️ [Carousel] Publishing ${mediaItems.length} items for User: ${req.user._id}`);
    const publishResult = await publishInstagramCarousel({
      igUserId,
      pageAccessToken: connectedFB.pageAccessToken,
      mediaItems,
      caption: caption || ''
    });

    // Save post entry to Database
    const postRecord = await Video.create({
      user: req.user._id,
      title: caption ? caption.substring(0, 50) : 'Instagram Carousel',
      description: caption || '',
      status: 'uploaded',
      platform: 'instagram',
      postType: 'carousel',
      platformPostId: publishResult.platformPostId,
      platformUrl: publishResult.platformUrl,
      mediaUrls: mediaItems.map((m) => m.url),
      diamondsCharged: creditInfo.diamondsCharged,
      usedFreeUpload: creditInfo.usedFreeUpload
    });

    res.status(201).json({
      success: true,
      message: 'Instagram Carousel published successfully!',
      post: postRecord,
      remainingDiamonds: req.user.diamondBalance,
      remainingFreeUploads: req.user.freeUploadsRemaining
    });

  } catch (err) {
    console.error('❌ [Carousel Error]:', err.message);
    const status = err.code === 'INSUFFICIENT_DIAMONDS' ? 402 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

// ==========================================
// 2. INSTAGRAM REEL POST
// Route: POST /api/posts/instagram/reel
// ==========================================
router.post('/instagram/reel', protect, async (req, res) => {
  try {
    const { videoUrl, caption } = req.body;

    if (!videoUrl) {
      return res.status(400).json({ success: false, message: 'videoUrl is required.' });
    }

    const connectedFB = req.user.connectedFacebook;
    if (!connectedFB?.pageId || !connectedFB?.pageAccessToken) {
      return res.status(400).json({
        success: false,
        message: 'Facebook Page is not connected. Please connect Meta via OAuth first.'
      });
    }

    const creditInfo = await handlePublishCredits(req.user);
    const igUserId = await getInstagramAccountId(connectedFB.pageId, connectedFB.pageAccessToken);

    console.log(`▶️ [IG Reel] Publishing reel for User: ${req.user._id}`);
    const publishResult = await publishInstagramReel({
      igUserId,
      pageAccessToken: connectedFB.pageAccessToken,
      videoUrl,
      caption: caption || ''
    });

    const postRecord = await Video.create({
      user: req.user._id,
      title: caption ? caption.substring(0, 50) : 'Instagram Reel',
      description: caption || '',
      status: 'uploaded',
      platform: 'instagram',
      postType: 'reel',
      videoUrl,
      platformPostId: publishResult.platformPostId,
      platformUrl: publishResult.platformUrl,
      diamondsCharged: creditInfo.diamondsCharged,
      usedFreeUpload: creditInfo.usedFreeUpload
    });

    res.status(201).json({
      success: true,
      message: 'Instagram Reel published successfully!',
      post: postRecord,
      remainingDiamonds: req.user.diamondBalance,
      remainingFreeUploads: req.user.freeUploadsRemaining
    });

  } catch (err) {
    console.error('❌ [IG Reel Error]:', err.message);
    const status = err.code === 'INSUFFICIENT_DIAMONDS' ? 402 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

// ==========================================
// 3. FACEBOOK REEL POST
// Route: POST /api/posts/facebook/reel
// ==========================================
router.post('/facebook/reel', protect, async (req, res) => {
  try {
    const { videoUrl, caption } = req.body;

    if (!videoUrl) {
      return res.status(400).json({ success: false, message: 'videoUrl is required.' });
    }

    const connectedFB = req.user.connectedFacebook;
    if (!connectedFB?.pageId || !connectedFB?.pageAccessToken) {
      return res.status(400).json({
        success: false,
        message: 'Facebook Page is not connected. Please connect Meta via OAuth first.'
      });
    }

    const creditInfo = await handlePublishCredits(req.user);

    console.log(`▶️ [FB Reel] Publishing reel for User: ${req.user._id}`);
    const publishResult = await publishFacebookReel({
      pageId: connectedFB.pageId,
      pageAccessToken: connectedFB.pageAccessToken,
      videoUrl,
      caption: caption || ''
    });

    const postRecord = await Video.create({
      user: req.user._id,
      title: caption ? caption.substring(0, 50) : 'Facebook Reel',
      description: caption || '',
      status: 'uploaded',
      platform: 'facebook',
      postType: 'reel',
      videoUrl,
      platformPostId: publishResult.platformPostId,
      platformUrl: publishResult.platformUrl,
      diamondsCharged: creditInfo.diamondsCharged,
      usedFreeUpload: creditInfo.usedFreeUpload
    });

    res.status(201).json({
      success: true,
      message: 'Facebook Reel published successfully!',
      post: postRecord,
      remainingDiamonds: req.user.diamondBalance,
      remainingFreeUploads: req.user.freeUploadsRemaining
    });

  } catch (err) {
    console.error('❌ [FB Reel Error]:', err.message);
    const status = err.code === 'INSUFFICIENT_DIAMONDS' ? 402 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

module.exports = router;
