const { google } = require('googleapis');
const stream = require('stream');

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
    requestBody: {
      name: filename,
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID]
    },
    media: {
      mimeType,
      body: bufferStream
    },
    fields: 'id, webViewLink, webContentLink'
  });

  // Make file readable via link so it can be fetched later for YouTube upload
  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: { role: 'reader', type: 'anyone' }
  });

  return res.data; // { id, webViewLink, webContentLink }
};

const getDriveFileStream = async (fileId) => {
  const drive = getDriveClient();
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );
  return res.data;
};

// Permanently deletes a previously uploaded file from Google Drive. Used once
// the video has been successfully pushed to YouTube, so we don't keep a
// redundant copy of the file in our own storage.
const deleteDriveFile = async (fileId) => {
  const drive = getDriveClient();
  return drive.files.delete({ fileId });
};

module.exports = { uploadBufferToDrive, getDriveFileStream, deleteDriveFile };
