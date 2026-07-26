const mongoose = require('mongoose');

const RatingSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  email: { type: String, default: '' },
  stars: { type: Number, min: 1, max: 5, default: null },
  reviewText: { type: String, default: '' },
  // A "skip" also creates a row (with skipped: true, stars: null) purely so
  // we have a timestamp to measure the 7-day weekly-prompt window against —
  // without this, skipping would make the popup reappear on every app open.
  skipped: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Rating', RatingSchema);
