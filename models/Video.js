const mongoose = require('mongoose');

// Per-platform publish record. Each video can target multiple platforms
// independently — each with its own metadata, schedule time, and status, so
// (for example) YouTube can succeed while Facebook fails and only
// Facebook gets retried.
const PlatformTargetSchema = new mongoose.Schema({
  platform: { type: String, enum: ['youtube', 'facebook'], required: true },
  status: {
    type: String,
    enum: ['pending', 'queued', 'processing', 'uploaded', 'failed'],
    default: 'pending'
  },
  scheduledAt: { type: Date, default: null }, // null = publish as soon as the video is queued

  // YouTube-specific metadata
  title: { type: String, default: '' },
  description: { type: String, default: '' },
  tags: [{ type: String }],
  category: { type: String, default: '22' },
  playlist: { type: String, default: '' },
  audience: { type: String, enum: ['made_for_kids', 'not_for_kids'], default: 'not_for_kids' },
  privacyStatus: { type: String, enum: ['public', 'unlisted', 'private'], default: 'public' },
  targetPrivacyStatus: { type: String, enum: ['public', 'unlisted', 'private'], default: null },
  // YouTube only. When a target has a future scheduledAt, the scheduler
  // uploads it immediately as 'unlisted' so it's fully processed and ready,
  // then flips it to targetPrivacyStatus once scheduledAt arrives (see
  // cron/scheduler.js -> promoteScheduledYouTubeVideos). This flag tracks
  // whether that final promotion has happened yet — false right after the
  // initial (possibly unlisted) upload, true once it's at its real target
  // privacy. For targets with no future schedule, this is set to true at
  // upload time since there's nothing left to promote.
  youtubePrivacyPromoted: { type: Boolean, default: false },
  thumbnailUrl: { type: String, default: '' },

  // Facebook metadata
  caption: { type: String, default: '' },
  hashtags: [{ type: String }],

  // Result fields, populated once processed
  platformPostId: { type: String, default: '' },
  platformUrl: { type: String, default: '' },
  failReason: { type: String, default: '' },
  retryCount: { type: Number, default: 0 }
}, { _id: false });

const VideoSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  // The ONE video file the user uploaded — shared across every platform
  // target below. We upload it once to temporary storage and reuse the same
  // file/URL for every platform, per the "upload once, publish everywhere"
  // requirement.
  storageProvider: { type: String, enum: ['cloudinary_1', 'cloudinary_2', 'google_drive', 'youtube'], default: null },
  storageFileId: { type: String, default: '' },
  storageUrl: { type: String, default: '' },
  fileSizeBytes: { type: Number, default: 0 },
  storageDeleteAt: { type: Date, default: null },

  sourceProvider: { type: String, enum: ['manual', 'drive_auto'], default: 'manual' },
  sourceDriveFileId: { type: String, default: '' },

  // One entry per platform the user selected for this video.
  platforms: { type: [PlatformTargetSchema], default: [] },

  // Overall status derived from platforms[] — 'uploaded' only once every
  // platform target is uploaded; 'failed' if every target failed; otherwise
  // 'processing'/'queued' while any target is still in flight. Kept as an
  // explicit field (rather than computed only on read) so existing queries
  // like Video.find({ status: 'queued' }) keep working.
  status: {
    type: String,
    enum: ['draft', 'queued', 'processing', 'uploaded', 'partially_uploaded', 'failed'],
    default: 'draft'
  },

  diamondsCharged: { type: Number, default: 0 },
  usedFreeUpload: { type: Boolean, default: false },

  aiGenerated: {
    title: { type: Boolean, default: false },
    description: { type: Boolean, default: false },
    tags: { type: Boolean, default: false },
    caption: { type: Boolean, default: false },
    hashtags: { type: Boolean, default: false }
  }
}, { timestamps: true });

// Recomputes the parent `status` field from the current state of
// `platforms[]`. Call this after mutating any platform target's status.
//
// NOTE: a YouTube target that's 'uploaded' but still waiting on
// youtubePrivacyPromoted (i.e. uploaded unlisted, waiting for its
// scheduled public time) still counts as 'uploaded' here — the promotion
// step is a background metadata patch, not part of the publish pipeline
// that this status tracks.
VideoSchema.methods.recomputeStatus = function () {
  const statuses = this.platforms.map((p) => p.status);
  if (statuses.length === 0) { this.status = 'draft'; return; }
  if (statuses.every((s) => s === 'uploaded')) { this.status = 'uploaded'; return; }
  if (statuses.every((s) => s === 'failed')) { this.status = 'failed'; return; }
  if (statuses.some((s) => s === 'processing' || s === 'queued' || s === 'pending')) { this.status = 'queued'; return; }
  this.status = 'partially_uploaded';
};

module.exports = mongoose.model('Video', VideoSchema);
