import { getCredentials } from "./credentials";
import { Encryption } from "./encryption";
import { UserSettings } from "./settings";
import { EntryStorage } from "./storage";

/**
 * `EntryStorage.backupGetExport` refuses to export an encrypted vault while it
 * is locked. Callers use this to tell "needs unlock" apart from a real failure.
 */
export function isVaultLockedError(error: unknown): boolean {
  return error instanceof Error && error.message === "encryptionRequired";
}

function isNativeChromeIdentity(): boolean {
  return (
    navigator.userAgent.indexOf("Chrome") !== -1 &&
    navigator.userAgent.indexOf("OPR") === -1 &&
    navigator.userAgent.indexOf("Edg") === -1
  );
}

export class Dropbox implements BackupProvider {
  private async getToken() {
    await UserSettings.updateItems();
    return UserSettings.items.dropboxToken || "";
  }

  async upload(encryption: Encryption): Promise<boolean> {
    await UserSettings.updateItems();

    if (UserSettings.items.dropboxEncrypted === undefined) {
      // Encrypt by default if user hasn't set yet
      UserSettings.items.dropboxEncrypted = true;
      await UserSettings.commitItems();
    }
    let exportData;
    try {
      exportData = await EntryStorage.backupGetExport(
        encryption,
        UserSettings.items.dropboxEncrypted === true
      );
    } catch (error) {
      // Never swallow this: the caller reports "locked" vs "failed" from it.
      console.error("[Dropbox] Unable to build the export:", error);
      throw error;
    }
    const backup = JSON.stringify(exportData, null, 2);

    const url = "https://content.dropboxapi.com/2/files/upload";
    const token = await this.getToken();
    if (!token) {
      return false;
    }

    const now = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const apiArg = {
      path: `/${now}.json`,
      mode: "add",
      autorename: true,
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify(apiArg),
      },
      body: backup,
    });

    if (response.status === 401) {
      UserSettings.items.dropboxToken = undefined;
      UserSettings.items.dropboxRevoked = true;
      await UserSettings.commitItems();
      return false;
    }

    const res = await response.json();
    return Boolean(res.name);
  }

  async getUser(): Promise<string> {
    await UserSettings.updateItems();
    const url = "https://api.dropboxapi.com/2/users/get_current_account";
    const token = await this.getToken();
    if (!token) {
      return "Error: No token";
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
        },
      });

      if (response.status === 401) {
        UserSettings.items.dropboxToken = undefined;
        UserSettings.items.dropboxRevoked = true;
        await UserSettings.commitItems();
        return "Error: Response was 401. You will be logged out the next time you open Authenticator.";
      }

      const res = await response.json();
      if (res.email) {
        return res.email;
      }
      console.error("Could not find email in response.", res);
      return "Error: res.email was undefined.";
    } catch (e) {
      console.error(e);
      return "Error";
    }
  }
}

export class Drive implements BackupProvider {
  private async getToken() {
    await UserSettings.updateItems();
    let needsRefresh = !UserSettings.items.driveToken;

    if (!needsRefresh) {
      const response = await fetch(
        "https://www.googleapis.com/drive/v3/files",
        {
          method: "GET",
          headers: {
            Authorization: "Bearer " + UserSettings.items.driveToken,
          },
        }
      );
      const res = await response.json();
      if (res.error) {
        if (res.error.code === 401) {
          if (isNativeChromeIdentity() && UserSettings.items.driveToken) {
            // Clear invalid token from chrome://identity-internals/
            await chrome.identity.removeCachedAuthToken({
              token: UserSettings.items.driveToken,
            });
          }
          UserSettings.items.driveToken = undefined;
          await UserSettings.commitItems();
          needsRefresh = true;
        }
      }
    }

    if (needsRefresh) {
      await this.refreshToken();
    }
    return UserSettings.items.driveToken;
  }

  private async refreshToken(): Promise<boolean> {
    await UserSettings.updateItems();

    if (isNativeChromeIdentity()) {
      return new Promise((resolve: (value: boolean) => void) => {
        chrome.identity.getAuthToken(
          {
            interactive: false,
            scopes: ["https://www.googleapis.com/auth/drive.file"],
          },
          async (token) => {
            UserSettings.items.driveToken = token;
            if (!token) {
              UserSettings.items.driveRevoked = true;
            }
            try {
              await UserSettings.commitItems();
            } catch (error) {
              console.error("[Drive] Failed to persist token:", error);
            }
            resolve(Boolean(token));
          }
        );
      });
    }

    const tokenBody = new URLSearchParams({
      client_id: getCredentials().drive.client_id,
      client_secret: getCredentials().drive.client_secret,
      refresh_token: UserSettings.items.driveRefreshToken || "",
      grant_type: "refresh_token",
    });

    const response = await fetch("https://www.googleapis.com/oauth2/v4/token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: tokenBody.toString(),
    });

    if (response.status === 401) {
      UserSettings.items.driveRefreshToken = undefined;
      UserSettings.items.driveRevoked = true;
      await UserSettings.commitItems();
      return false;
    }

    const res = await response.json();
    if (res.error) {
      if (res.error === "invalid_grant") {
        UserSettings.items.driveRefreshToken = undefined;
        UserSettings.items.driveRevoked = true;
        await UserSettings.commitItems();
      }
      console.error(res.error_description);
      return false;
    }

    UserSettings.items.driveToken = res.access_token;
    await UserSettings.commitItems();
    return true;
  }

  private async getFolder() {
    const token = await this.getToken();
    if (!token) {
      return false;
    }
    await UserSettings.updateItems();

    if (UserSettings.items.driveFolder) {
      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
          UserSettings.items.driveFolder
        )}?fields=trashed`,
        {
          method: "GET",
          headers: {
            Authorization: "Bearer " + token,
            Accept: "application/json",
          },
        }
      );

      if (response.status === 401) {
        UserSettings.items.driveToken = undefined;
        await UserSettings.commitItems();
        return false;
      }

      const res = await response.json();
      if (res.error) {
        if (res.error.code === 404) {
          UserSettings.items.driveFolder = undefined;
          await UserSettings.commitItems();
        } else {
          console.error(res.error.message);
          return false;
        }
      } else if (res.trashed) {
        UserSettings.items.driveFolder = undefined;
        await UserSettings.commitItems();
      }
    }

    if (!UserSettings.items.driveFolder) {
      const response = await fetch(
        "https://www.googleapis.com/drive/v3/files/",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: "Authenticator Backups",
            mimeType: "application/vnd.google-apps.folder",
          }),
        }
      );

      if (response.status === 401) {
        UserSettings.items.driveToken = undefined;
        await UserSettings.commitItems();
        return false;
      }

      const res = await response.json();
      if (!res.error) {
        UserSettings.items.driveFolder = res.id;
        await UserSettings.commitItems();
      } else {
        console.error(res.error.message);
        return false;
      }
    }

    return UserSettings.items.driveFolder;
  }

  async upload(encryption: Encryption): Promise<boolean> {
    await UserSettings.updateItems();
    if (UserSettings.items.driveEncrypted === undefined) {
      UserSettings.items.driveEncrypted = true;
      await UserSettings.commitItems();
    }
    let exportData;
    try {
      exportData = await EntryStorage.backupGetExport(
        encryption,
        UserSettings.items.driveEncrypted === true
      );
    } catch (error) {
      // Never swallow this: the caller reports "locked" vs "failed" from it.
      console.error("[Drive] Unable to build the export:", error);
      throw error;
    }
    const backup = JSON.stringify(exportData, null, 2);

    const token = await this.getToken();
    if (!token) {
      return false;
    }
    const folderId = await this.getFolder();
    if (!folderId) {
      return false;
    }

    const now = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const requestData = [
      "--segment_marker",
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify({
        name: `${now}.json`,
        parents: [folderId],
      }),
      "",
      "--segment_marker",
      "Content-Type: application/octet-stream",
      "",
      backup,
      "--segment_marker--",
      "",
    ].join("\n");

    const response = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "multipart/related; boundary=segment_marker",
        },
        body: requestData,
      }
    );

    if (response.status === 401) {
      UserSettings.items.driveToken = undefined;
      await UserSettings.commitItems();
      return false;
    }

    const res = await response.json();
    if (!res.error) {
      return true;
    }
    console.error(res.error.message);
    return false;
  }

  async getUser(): Promise<string> {
    const token = await this.getToken();
    if (!token) {
      return "Error: Access revoked or expired.";
    }

    await UserSettings.updateItems();
    try {
      const response = await fetch(
        "https://www.googleapis.com/drive/v2/about?fields=user",
        {
          method: "GET",
          headers: {
            Authorization: "Bearer " + token,
          },
        }
      );

      if (response.status === 401) {
        UserSettings.items.driveToken = undefined;
        await UserSettings.commitItems();
        return "Error: Response was 401. You will be logged out the next time you open Authenticator.";
      }

      const res = await response.json();
      if (!res.error) {
        return res.user.emailAddress;
      }
      console.error(res.error.message);
      return "Error";
    } catch (e) {
      console.error(e);
      return "Error";
    }
  }
}

export class OneDrive implements BackupProvider {
  private async getToken() {
    await UserSettings.updateItems();
    let needsRefresh = !UserSettings.items.oneDriveToken;

    if (!needsRefresh) {
      const response = await fetch(
        "https://graph.microsoft.com/v1.0/me/drive/special/approot",
        {
          method: "GET",
          headers: {
            Authorization: "Bearer " + UserSettings.items.oneDriveToken,
          },
        }
      );
      const res = await response.json();
      if (res.error && (response.status === 401 || res.error.code === 401)) {
        UserSettings.items.oneDriveToken = undefined;
        await UserSettings.commitItems();
        needsRefresh = true;
      }
    }

    if (needsRefresh) {
      await this.refreshToken();
    }
    return UserSettings.items.oneDriveToken;
  }

  private async refreshToken(): Promise<boolean> {
    await UserSettings.updateItems();
    const tokenBody = new URLSearchParams({
      client_id: getCredentials().onedrive.client_id,
      refresh_token: UserSettings.items.oneDriveRefreshToken || "",
      client_secret: getCredentials().onedrive.client_secret,
      grant_type: "refresh_token",
      scope: `https://graph.microsoft.com/Files.ReadWrite${
        UserSettings.items.oneDriveBusiness !== true ? ".AppFolder" : ""
      } https://graph.microsoft.com/User.Read offline_access`,
    });

    const response = await fetch(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: tokenBody.toString(),
      }
    );

    if (response.status === 401) {
      UserSettings.items.oneDriveRefreshToken = undefined;
      UserSettings.items.oneDriveRevoked = true;
      await UserSettings.commitItems();
      return false;
    }

    const res = await response.json();
    if (res.error) {
      if (res.error === "invalid_grant") {
        UserSettings.items.oneDriveRefreshToken = undefined;
        UserSettings.items.oneDriveRevoked = true;
        await UserSettings.commitItems();
      }
      console.error(res.error_description);
      return false;
    }

    UserSettings.items.oneDriveToken = res.access_token;
    await UserSettings.commitItems();
    return true;
  }

  async upload(encryption: Encryption): Promise<boolean> {
    await UserSettings.updateItems();
    if (UserSettings.items.oneDriveEncrypted === undefined) {
      UserSettings.items.oneDriveEncrypted = true;
      await UserSettings.commitItems();
    }
    let exportData;
    try {
      exportData = await EntryStorage.backupGetExport(
        encryption,
        UserSettings.items.oneDriveEncrypted === true
      );
    } catch (error) {
      // Never swallow this: the caller reports "locked" vs "failed" from it.
      console.error("[OneDrive] Unable to build the export:", error);
      throw error;
    }
    const backup = JSON.stringify(exportData, null, 2);

    const token = await this.getToken();
    if (!token) {
      return false;
    }

    const now = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const response = await fetch(
      `https://graph.microsoft.com/v1.0/me/drive/special/approot:/${now}.json:/content`,
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/octet-stream",
        },
        body: backup,
      }
    );

    if (response.status === 401) {
      await UserSettings.removeItem("oneDriveToken");
      return false;
    }

    const res = await response.json();
    if (!res.error) {
      return true;
    }
    console.error(res.error.message);
    return false;
  }

  async getUser(): Promise<string> {
    const token = await this.getToken();
    if (!token) {
      return "Error: Access revoked or expired.";
    }

    await UserSettings.updateItems();
    try {
      const response = await fetch("https://graph.microsoft.com/v1.0/me/", {
        method: "GET",
        headers: {
          Authorization: "Bearer " + token,
        },
      });

      if (response.status === 401) {
        UserSettings.items.oneDriveToken = undefined;
        await UserSettings.commitItems();
        return "Error: Response was 401. You will be logged out the next time you open Authenticator.";
      }

      const res = await response.json();
      if (!res.error) {
        return res.userPrincipalName;
      }
      console.error(res.error.message);
      return "Error";
    } catch (e) {
      console.error(e);
      return "Error";
    }
  }
}
