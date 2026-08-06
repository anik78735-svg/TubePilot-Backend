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

// Deducts either a free upload slot or diamonds. Charged ONCE per upload
// regardless of how many platforms are selected — the user uploads one
// video file, not one per platform.
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
    return { storageProvider: picked.key, storageFileId: result.public_id, storageUrl: result.secure_url };
  }
  const driveFile = await uploadBufferToDrive(buffer, filename, mimetype);
  return { storageProvider: 'google_drive', storageFileId: driveFile.id, storageUrl: driveFile.webViewLink };
};

const parseCommaList = (str) => (str ? str.split(',').map((t) => t.trim()).filter(Boolean) : []);
const parseJson = (str, fallback = {}) => {
  try { return JSON.parse(str); } catch (_) { return fallback; }
};

// @route POST /api/videos/upload
// multipart/form-data:
//   video (file, required), thumbnail (file, optional — YouTube only)
//   platforms: JSON array e.g. '["youtube","instagram","facebook"]'
//   youtube:   JSON e.g. '{"title":"...","description":"...","tags":"a,b",
//                          "category":"22","playlist":"","audience":"not_for_kids",
//                          "privacyStatus":"public","scheduledAt":"2026-08-05T18:00:00Z"}'
//   instagram: JSON e.g. '{"caption":"...","hashtags":"a,b","location":"",
//                          "scheduledAt":"2026-08-05T19:15:00Z"}'
//   facebook:  JSON e.g. '{"caption":"...","hashtags":"a,b",
//                          "scheduledAt":"2026-08-05T20:30:00Z"}'
// scheduledAt on each platform = when to run that platform's publish. Omit
// (or leave null) to publish as soon as it's picked up by the scheduler
// (Mode 1 "Publish Everywhere" just sends the same scheduledAt for every
// selected platform from the app; Mode 2 sends different times per platform
// — the backend doesn't need to know which UI mode was used).
router.post('/upload', protect, upload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]), async (req, res) => {
  try {
    const user = req.user;
    if (!req.files || !req.files.video) {
      return res.status(400).json({ success: false, message: 'Video file is required' });
    }

    const platformsRequested = parseJson(req.body.platforms, []);
    if (!Array.isArray(platformsRequested) || platformsRequested.length === 0) {
      return res.status(400).json({ success: false, message: 'Select at least one platform' });
    }

    // Validate every requested platform is actually connected BEFORE
    // charging anything.
    for (const p of platformsRequested) {
      if (p === 'youtube' && !user.youtubeChannel) {
        return res.status(400).json({ success: false, message: 'Connect your YouTube channel first', code: 'YOUTUBE_NOT_CONNECTED' });
      }
      if (p === 'instagram' && !user.connectedInstagram) {
        return res.status(400).json({ success: false, message: 'Connect Instagram first', code: 'INSTAGRAM_NOT_CONNECTED' });
      }
      if (p === 'facebook' && !user.connectedFacebook) {
        return res.status(400).json({ success: false, message: 'Connect Facebook first', code: 'FACEBOOK_NOT_CONNECTED' });
      }
    }

    // Charge BEFORE the (slow) upload so we never store a video the user can't afford.
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

    const platforms = [];
    for (const p of platformsRequested) {
      if (p === 'youtube') {
        const yt = parseJson(req.body.youtube, {});
        const requestedPrivacy = ['public', 'unlisted', 'private'].includes(yt.privacyStatus) ? yt.privacyStatus : 'public';
        const scheduledAt = yt.scheduledAt ? new Date(yt.scheduledAt) : null;
        platforms.push({
          platform: 'youtube',
          status: scheduledAt && scheduledAt > new Date() ? 'pending' : 'queued',
          scheduledAt,
          title: yt.title || '',
          description: yt.description || '',
          tags: parseCommaList(yt.tags),
          category: yt.category || '22',
          playlist: yt.playlist || '',
          audience: yt.audience || 'not_for_kids',
          privacyStatus: requestedPrivacy,
          targetPrivacyStatus: requestedPrivacy,
          thumbnailUrl
        });
      } else if (p === 'instagram') {
        const ig = parseJson(req.body.instagram, {});
        const scheduledAt = ig.scheduledAt ? new Date(ig.scheduledAt) : null;
        platforms.push({
          platform: 'instagram',
          status: scheduledAt && scheduledAt > new Date() ? 'pending' : 'queued',
          scheduledAt,
          caption: ig.caption || '',
          hashtags: parseCommaList(ig.hashtags),
          location: ig.location || ''
        });
      } else if (p === 'facebook') {
        const fb = parseJson(req.body.facebook, {});
        const scheduledAt = fb.scheduledAt ? new Date(fb.scheduledAt) : null;
        platforms.push({
          platform: 'facebook',
          status: scheduledAt && scheduledAt > new Date() ? 'pending' : 'queued',
          scheduledAt,
          caption: fb.caption || '',
          hashtags: parseCommaList(fb.hashtags)
        });
      }
    }

    if (!platforms.length) {
      return res.status(400).json({ success: false, message: 'No valid platforms selected' });
    }

    const video = await Video.create({
      user: user._id,
      storageProvider: stored.storageProvider,
      storageFileId: stored.storageFileId,
      storageUrl: stored.storageUrl,
      fileSizeBytes: videoFile.size,
      platforms,
      status: 'queued',
      diamondsCharged: charge.diamondsCharged,
      usedFreeUpload: charge.usedFreeUpload
    });

    user.storageUsedBytes += videoFile.size;
    await user.save();

    res.status(201).json({ success: true, video });
  } catch (err) {
    if (err.code === 'INSUFFICIENT_DIAMONDS') {
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

// @route GET /api/videos?status=queued|uploaded|draft|failed|partially_uploaded
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

// @route PATCH /api/videos/:id/schedule/:platform  { scheduledAt }
// Reschedule ONE platform target on a video (e.g. only push Instagram's time back).
router.patch('/:id/schedule/:platform', protect, async (req, res) => {
  try {
    const { scheduledAt } = req.body;
    if (!scheduledAt) return res.status(400).json({ success: false, message: 'scheduledAt is required' });

    const video = await Video.findOne({ _id: req.params.id, user: req.user._id });
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });

    const target = video.platforms.find((p) => p.platform === req.params.platform);
    if (!target) return res.status(404).json({ success: false, message: 'Platform target not found on this video' });
    if (target.status === 'uploaded') return res.status(400).json({ success: false, message: 'Already published to this platform' });

    target.scheduledAt = new Date(scheduledAt);
    target.status = target.scheduledAt > new Date() ? 'pending' : 'queued';
    video.recomputeStatus();
    await video.save();

    res.json({ success: true, video });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route DELETE /api/videos/:id  (cancel every not-yet-uploaded platform target)
router.delete('/:id', protect, async (req, res) => {
  try {
    const video = await Video.findOne({ _id: req.params.id, user: req.user._id });
    if (!video) return res.status(404).json({ success: false, message: 'Video not found' });
    if (video.status === 'uploaded') {
      return res.status(400).json({ success: false, message: 'Cannot delete an already fully-uploaded video from here' });
    }

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
      message: 'Your upload was cancelled and your credit was refunded.'
    });

    res.json({ success: true, message: 'Video cancelled and credit refunded' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
module.exports.chargeForUpload = chargeForUpload;
module.exports.storeVideoFile = storeVideoFile;
