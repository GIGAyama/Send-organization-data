// ▼初回認証時にDriveのアクセス権限を付与するためのダミー関数（実行はしません）
function setupAuth() {
  DriveApp.getRootFolder();
}

function doPost(e) {
  try {
    var params = JSON.parse(e.postData.contents);
    var isConversion = params.targetMimeType && params.targetMimeType.length > 0;

    // メタデータ: 変換する場合はGoogle形式のMIMEタイプを指定し拡張子を除去、
    //             変換しない場合は元のMIMEタイプを指定しファイル名をそのまま保持
    var metadata = {};
    if (isConversion) {
      metadata.name = params.fileName.replace(/\.[^/.]+$/, "");
      metadata.mimeType = params.targetMimeType;
    } else {
      metadata.name = params.fileName;
      metadata.mimeType = params.mimeType;
    }

    // Drive REST API でマルチパートアップロード
    var boundary = "-------314159265358979323846";
    var body = "--" + boundary + "\r\n"
             + "Content-Type: application/json; charset=UTF-8\r\n\r\n"
             + JSON.stringify(metadata) + "\r\n"
             + "--" + boundary + "\r\n"
             + "Content-Type: " + params.mimeType + "\r\n"
             + "Content-Transfer-Encoding: base64\r\n\r\n"
             + params.base64 + "\r\n"
             + "--" + boundary + "--";

    var options = {
      method: "post",
      contentType: "multipart/related; boundary=" + boundary,
      payload: body,
      headers: {
        "Authorization": "Bearer " + ScriptApp.getOAuthToken()
      },
      muteHttpExceptions: true
    };

    var response = UrlFetchApp.fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
      options
    );
    var result = JSON.parse(response.getContentText());

    if (response.getResponseCode() !== 200) {
      throw new Error("API Error: " + response.getContentText());
    }

    // 作成されたファイルのURLを生成（ファイル種別に応じて適切なURLを返す）
    var fileUrl = getFileUrl(result.id, isConversion ? params.targetMimeType : "");

    return ContentService.createTextOutput(JSON.stringify({
      status: "success",
      url: fileUrl
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ▼ ファイル種別に応じた正しいURLを生成するヘルパー
function getFileUrl(fileId, targetMimeType) {
  switch (targetMimeType) {
    case "application/vnd.google-apps.document":
      return "https://docs.google.com/document/d/" + fileId + "/edit";
    case "application/vnd.google-apps.spreadsheet":
      return "https://docs.google.com/spreadsheets/d/" + fileId + "/edit";
    case "application/vnd.google-apps.presentation":
      return "https://docs.google.com/presentation/d/" + fileId + "/edit";
    default:
      return "https://drive.google.com/file/d/" + fileId + "/view";
  }
}
