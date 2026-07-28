const { google } = require('googleapis');
const stream = require('stream');

// ---------------- System-wide storage Drive account ----------------
// Used internally as a storage fallback (Cloudinary 1 -> Cloudinary 2 -> this)
// when a video is uploaded manually or picked up via auto-upload. Unchanged.
const getDriveClient = () => {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_DRIVE_REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth: oauth2Client });
};

const uploadBufferToDrive = async (buffer, filename, mimeType) => {
  const drive = getDriveClient();
  const bufferStream = new stream.PassThrough();
  bufferStream.end(buffer);
  const res = await drive.files.create({
    requestBody: { name: filename, parents: [process.env.GOOGLE_DRIVE_FOLDER_ID] },
    media: { mimeType, body: bufferStream },
    fields: 'id, webViewLink, webContentLink'
  });
  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: { role: 'reader', type: 'anyone' }
  });
  return res.data;
};

const getDriveFileStream = async (fileId) => {
  const drive = getDriveClient();
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  return res.data;
};

const deleteDriveFile = async (fileId) => {
  const drive = getDriveClient();
  return drive.files.delete({ fileId });
};

// ---------------- User's own connected Drive (NEW) ----------------

// Dedicated OAuth client for the USER-facing Drive-connect flow. Must use a
// SEPARATE redirect URI from the YouTube one (GOOGLE_REDIRECT_URI), because
// Google requires the redirect_uri used when exchanging a code for tokens to
// exactly match the one used when generating the consent URL. Reusing
// utils/youtube.js's client here would silently bounce users back to the
// YouTube callback route instead of /api/drive/oauth/callback.
const getDriveOAuthClient = () => {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_DRIVE_REDIRECT_URI
  );
};

// Exchanges the authorization code (from the Drive consent screen) for tokens.
const exchangeCodeForDriveTokens = async (code) => {
  const oauth2Client = getDriveOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens; // { access_token, refresh_token, expiry_date, ... }
};

// Builds a Drive client authenticated as the USER (via their stored
// connectedDrive.refreshToken), not the system storage account. Redirect URI
// is irrelevant here — it's only required for generateAuthUrl()/getToken(),
// not for refresh-token based API calls.
const getUserDriveClient = (user) => {
  if (!user.connectedDrive || !user.connectedDrive.refreshToken) {
    throw new Error('User has no connected Google Drive');
  }
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_DRIVE_REDIRECT_URI
  );
  oauth2Client.setCredentials({ refresh_token: user.connectedDrive.refreshToken });
  return google.drive({ version: 'v3', auth: oauth2Client });
};

// Fetches the connected Drive account's display name/email — used right after
// OAuth callback to show "Connected as xyz@gmail.com" in the app.
const getUserDriveAccountInfo = async (accessToken) => {
  const oauth2Client = getDriveOAuthClient();
  oauth2Client.setCredentials({ access_token: accessToken });
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const res = await drive.about.get({ fields: 'user' });
  return res.data.user; // { displayName, emailAddress, photoLink }
};

// Lists video files in the user's connected Drive (optionally scoped to one
// folder via connectedDrive.folderId), oldest first, so auto-upload processes
// them in the order they were added.
const listUserDriveVideoFiles = async (user, pageSize = 50) => {
  const drive = getUserDriveClient(user);
  const folderId = user.connectedDrive.folderId;
  let q = "mimeType contains 'video/' and trashed = false";
  if (folderId) q += ` and '${folderId}' in parents`;
  const res = await drive.files.list({
    q,
    pageSize,
    fields: 'files(id, name, mimeType, size, createdTime)',
    orderBy: 'createdTime'
  });
  return res.data.files || [];
};

// Downloads one Drive file fully into memory as a Buffer so it can be re-used
// with the existing storeVideoFile() flow in routes/video.js (which expects
// a buffer, exactly like a multer file upload does).
const downloadUserDriveFileBuffer = async (user, fileId) => {
  const drive = getUserDriveClient(user);
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
};

module.exports = {
  // existing — unchanged
  uploadBufferToDrive,
  getDriveFileStream,
  deleteDriveFile,
  // new — user-connected Drive
  getDriveOAuthClient,
  exchangeCodeForDriveTokens,
  getUserDriveClient,
  getUserDriveAccountInfo,
  listUserDriveVideoFiles,
  downloadUserDriveFileBuffer
};
