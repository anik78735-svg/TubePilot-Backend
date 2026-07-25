const mongoose = require('mongoose');

const VideoSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  title: { type: String, required: true },
  description: { type: String, default: '' },
  tags: [{ type: String }],
  category: { type: String, default: '22' }, // YouTube category id
  playlist: { type: String, default: '' },
  audience: { type: String, enum: ['made_for_kids', 'not_for_kids'], default: 'not_for_kids' },
  privacyStatus: { type: String, enum: ['public', 'unlisted', 'private'], default: 'public' },

  // The privacy the user ultimately wants for this video. Normally equal to
  // privacyStatus. Differs only when the user picked "Public" with a future
  // Schedule Time: the video uploads immediately as 'unlisted' (privacyStatus),
  // and cron/scheduler.js flips privacyStatus to 'public' once scheduledAt
  // arrives, to match this target.
  targetPrivacyStatus: { type: String, enum: ['public', 'unlisted', 'private'], default: null },

  thumbnailUrl: { type: String, default: '' },

  // storage tracking
  storageProvider: { type: String, enum: ['cloudinary_1', 'cloudinary_2', 'google_drive', 'youtube'], default: null },
  storageFileId: { type: String, default: '' },
  storageUrl: { type: String, default: '' },
  fileSizeBytes: { type: Number, default: 0 },

  scheduledAt: { type: Date, default: null },

  status: {
    type: String,
    enum: ['draft', 'queued', 'uploading_storage', 'scheduled', 'processing', 'uploaded', 'failed'],
    default: 'draft'
  },
  failReason: { type: String, default: '' },

  youtubeVideoId: { type: String, default: '' },
  youtubeUrl: { type: String, default: '' },

  diamondsCharged: { type: Number, default: 0 },
  usedFreeUpload: { type: Boolean, default: false },

  aiGenerated: {
    title: { type: Boolean, default: false },
    description: { type: Boolean, default: false },
    tags: { type: Boolean, default: false }
  }
}, { timestamps: true });

module.exports = mongoose.model('Video', VideoSchema);
