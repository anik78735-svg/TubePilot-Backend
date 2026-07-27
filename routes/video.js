const express = require('express');
const { protect } = require('../middleware/auth');
const upload = require('../middleware/upload');
const Video = require('../models/Video');
const Notification = require('../models/Notification');
const { pickAvailableCloudinaryAccount, uploadBufferToCloudinary } = require('../utils/cloudinary');
const { uploadBufferToDrive } = require('../utils/googleDrive');
const { sendOneSignalToUser } = require('../utils/oneSignalPush');

const router = express.Router();

const DIAMOND_COST_PER_UPLOAD = Number(process.env.DIAMOND_COST_PER_UPLOAD || 10);

// Deducts either a free upload slot or diamonds. Throws if neither is available.
const chargeForUpload = (user) => {
  if (user.freeUploadsRemaining > 0) {
    user.freeUploadsRemaining -= 1;
    return { usedFreeUpload: true, diamondsCharged: 0 };
  }
  if (user.diamondBalance >= DIAMOND_COST_PER_UPLOAD) {
    user.diamondBalance -= DIAMOND_COST_PER_UPLOAD;
    return { usedFreeUpload: false, diamondsCharged: DIAMOND_COST_PER_UPLOAD };
  }
  const err = new Error('Not enough diamonds. Please buy more diamonds to upload.');
  err.code = 'INSUFFICIENT_DIAMONDS';
  throw err;
};

// Uploads the raw video buffer to storage, trying Cloudinary 1 -> Cloudinary 2 -> Google Drive
const storeVideoFile = async (buffer, filename, mimetype) => {
  const picked = await pickAvailableCloudinaryAccount(buffer.length);
  if (picked) {
    const result = await uploadBufferToCloudinary(picked.account, buffer, { public_id: filename });
    return {
      storageProvider: picked.key,
      storageFileId: result.public_id,
      storageUrl: result.secure_url
    };
  }

  // Both Cloudinary accounts full -> Google Drive
  const driveFile = await uploadBufferToDrive(buffer, filename, mimetype);
  return {
    storageProvider: 'google_drive',
    storageFileId: driveFile.id,
    storageUrl: driveFile.webViewLink
  };
};

// @route POST /api/videos/upload
// multipart/form-data: video, thumbnail(optional), title, description, tags, category, playlist, audience, scheduledAt(optional)
//
// Privacy behaviour:
// - privacyStatus 'unlisted' or 'private': uploads immediately with that privacy, and stays that way permanently.
// - privacyStatus 'public' with no scheduledAt: uploads immediately as public.
// - privacyStatus 'public' WITH scheduledAt: uploads immediately as 'unlisted' (so it's live but hidden),
//   and cron/scheduler.js's privacy-publish job flips it to 'public' once scheduledAt arrives.
router.post('/upload', protect, upload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]), async (req, res) => {
  try {
    const user = req.user;
    if (!req.files || !req.files.video) {
      return res.status(400).json({ success: false, message: 'Video file is required' });
    }

    const { title, description, tags, category, playlist, audience, privacyStatus, scheduledAt } = req.body;
    if (!title) return res.status(400).json({ success: false, message: 'Title is required' });
    if (!user.youtubeChannel) {
      return res.status(400).json({ success: false, message: 'Please connect a YouTube channel first' });
    }

    const requestedPrivacy = ['public', 'unlisted', 'private'].includes(privacyStatus) ? privacyStatus : 'public';
    // Only "Public + a future scheduledAt" delays going public; every other
    // combination uploads immediately at the privacy the user picked.
    const isDelayedPublic = requestedPrivacy === 'public' && !!scheduledAt;
    const initialPrivacyStatus = isDelayedPublic ? 'unlisted' : requestedPrivacy;

    // Charge credit BEFORE the (slow) upload so we never store a video the user can't afford
    const charge = chargeForUpload(user);

    const videoFile = req.files.video[0];
    const stored = await storeVideoFile(videoFile.buffer, `${user.userId}_${Date.now()}`, videoFile.mimetype);

    let thumbnailUrl = '';
    if (req.files.thumbnail) {
      const thumbFile = req.files.thumbnail[0];
      const thumbUpload = await uploadBufferToCloudinary(
        require('../utils/cloudinary').account1,
        thumbFile.buffer,
        { resource_type: 'image', public_id: `${user.userId}_thumb_${Date.now()}` }
      ).catch(() => null);
      thumbnailUrl = thumbUpload ? thumbUpload.secure_url : '';
    }

    const video = await Video.create({
      user: user._id,
      title,
      description: description || '',
      tags: tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      category: category || '22',
      playlist: playlist || '',
      audience: audience || 'not_for_kids',
      privacyStatus: initialPrivacyStatus,
      targetPrivacyStatus: requestedPrivacy,
      thumbnailUrl,
      storageProvider: stored.storageProvider,
      storageFileId: stored.storageFileId,
      storageUrl: stored.storageUrl,
      fileSizeBytes: videoFile.size,
      scheduledAt: isDelayedPublic ? scheduledAt : null,
      status: 'queued',
      diamondsCharged: charge.diamondsCharged,
      usedFreeUpload: charge.usedFreeUpload
    });

    user.storageUsedBytes += videoFile.size;
    await user.save();

    // Every video is picked up immediately by the same cron worker
    // (cron/scheduler.js) since status is always 'queued' here. If this is a
    // delayed-public video, a separate cron job in the same file later flips
    // its privacy from 'unlisted' to 'public' once scheduledAt arrives.

    res.status(201).json({ success: true, video });
  } catch (err) {
    if (err.code === 'INSUFFICIENT_DIAMONDS') {
      // Free uploads + diamonds are both exhausted — nudge the user via
      // OneSignal to buy more diamonds. This does NOT touch Firebase push
      // notifications used elsewhere in the app (utils/push.js), and it
      // never blocks or delays the error response sent back to the client.
      sendOneSignalToUser(req.user, {
        title: 'Your credits are over 💎',
        body: 'Your free uploads and diamonds are used up. Please buy diamonds to upload your video.',
        data: { type: 'insufficient_diamonds' }
      }).catch(() => {});
      return res.status(402).json({ success: false, message: err.message, code: err.code });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route GET /api/videos?status=scheduled|uploaded|draft|failed
router.get('/', protect, async (req, res) => {
  try {
    const filter = { user: req.user._id };
    if (req.query.status) filter.status = req.query.status;

    const videos = await Video.find(filter).sort({ createdAt: -1 }).limit(Number(req.query.limit) || 50);
    res.json({ success: true, videos });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route GET /api/videos/:id
router.get('/:id', protect, async (req, res) => {
  try {
    const video = await Video.findOne({ _id: req.params.id, user: req.user._id });
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    res.json({ success: true, video });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route PATCH /api/videos/:id/schedule  { scheduledAt }
router.patch('/:id/schedule', protect, async (req, res) => {
  try {
    const { scheduledAt } = req.body;
    if (!scheduledAt) return res.status(400).json({ success: false, message: 'scheduledAt is required' });

    const video = await Video.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { scheduledAt, status: 'scheduled' },
      { new: true }
    );
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });

    res.json({ success: true, video });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route DELETE /api/videos/:id  (cancel a scheduled/queued upload)
router.delete('/:id', protect, async (req, res) => {
  try {
    const video = await Video.findOne({ _id: req.params.id, user: req.user._id });
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    if (video.status === 'uploaded') {
      return res.status(400).json({ success: false, message: 'Cannot delete an already uploaded video from here' });
    }

    // Refund the credit that was charged
    if (video.usedFreeUpload) {
      req.user.freeUploadsRemaining += 1;
    } else if (video.diamondsCharged > 0) {
      req.user.diamondBalance += video.diamondsCharged;
    }
    await req.user.save();
    await video.deleteOne();

    await Notification.create({
      user: req.user._id,
      type: 'upload_failed',
      title: 'Upload Cancelled',
      message: `"${video.title}" was cancelled and your credit was refunded.`
    });

    res.json({ success: true, message: 'Video cancelled and credit refunded' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
