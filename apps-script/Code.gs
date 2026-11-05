var SECRET = "ВСТАВЬТЕ_СЕКРЕТ";
var PHOTO_FOLDER_ID = "ВСТАВЬТЕ_ID_ПАПКИ_ФОТО";
var COAT_FOLDER_ID = "ВСТАВЬТЕ_ID_ПАПКИ_ГЕРБОВ";

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (!body || body.secret !== SECRET) {
      return json_({ error: "Секрет не совпал" });
    }
    var folderId = body.kind === "coat" ? COAT_FOLDER_ID : PHOTO_FOLDER_ID;
    var bytes = Utilities.base64Decode(body.base64 || "");
    var blob = Utilities.newBlob(bytes, body.mime || "application/octet-stream", body.name || "file");
    var file = DriveApp.getFolderById(folderId).createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return json_({ id: file.getId() });
  } catch (err) {
    return json_({ error: String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
