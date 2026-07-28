const express = require('express');
const { protect } = require('../middleware/auth');
const Notification = require('../models/Notification');
const router = express.Router();

// @route GET /api/notifications
router.get('/', protect, async (req, res) => {
  const notifications = await Notification.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(50);
  const unreadCount = await Notification.countDocuments({ user: req.user._id, isRead: false });
  res.json({ success: true, notifications, unreadCount });
});

// @route PATCH /api/notifications/:id/read
router.patch('/:id/read', protect, async (req, res) => {
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, user: req.user._id },
    { isRead: true },
    { new: true }
  );
  if (!notification) return res.status(404).json({ success: false, message: 'Notification not found' });
  res.json({ success: true, notification });
});

// @route PATCH /api/notifications/read-all
router.patch('/read-all', protect, async (req, res) => {
  await Notification.updateMany({ user: req.user._id, isRead: false }, { isRead: true });
  res.json({ success: true, message: 'All notifications marked as read' });
});

// @route POST /api/notifications/register-device  { fcmToken }
// Called by the Flutter app after login so the backend can push real
// phone notifications (upload completed, payment approved, etc.)
router.post('/register-device', protect, async (req, res) => {
  const { fcmToken } = req.body;
  if (!fcmToken) return res.status(400).json({ success: false, message: 'fcmToken is required' });
  if (!req.user.fcmTokens.includes(fcmToken)) {
    req.user.fcmTokens.push(fcmToken);
    await req.user.save();
  }
  res.json({ success: true, message: 'Device registered for push notifications' });
});

// @route POST /api/notifications/register-onesignal-player  { playerId }
// Called by the Flutter app (OneSignal SDK) once it has a player/subscription
// id, so the backend can send OneSignal alerts. This is used ONLY for the
// "your free uploads + diamonds are exhausted, please buy more" alert (see
// utils/oneSignalPush.js -> sendOneSignalToUser). Kept completely separate
// from register-device (Firebase/FCM) above, which handles every other push.
router.post('/register-onesignal-player', protect, async (req, res) => {
  const { playerId } = req.body;
  if (!playerId) return res.status(400).json({ success: false, message: 'playerId is required' });
  if (!req.user.oneSignalPlayerIds.includes(playerId)) {
    req.user.oneSignalPlayerIds.push(playerId);
    await req.user.save();
  }
  res.json({ success: true, message: 'Device registered for OneSignal alerts' });
});

module.exports = router;
